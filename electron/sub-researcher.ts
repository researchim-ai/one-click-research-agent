/**
 * Lightweight sub-researcher: a constrained agent loop that uses search + reflect tools
 * to answer a focused sub-question and return a short synthesised report. Results are
 * funnelled into the parent's SourceTracker so citations flow into the main report.
 *
 * The implementation deliberately avoids re-entering the full runAgent so that it can
 * stay fully synchronous-ish (search tools are sync via subprocess) and be invoked
 * from within a tool call.
 */

import { getSourceTracker, extractSourcesFromToolResult } from './sources'

export interface SubResearcherOptions {
  task: string
  maxIters?: number
  parentSessionId: string
  budgetTokens?: number
  apiUrl: string
  temperature?: number
}

export interface SubResearcherResult {
  report: string
  iterations: number
  sourcesAdded: number
  toolCallsMade: string[]
}

const SUB_TOOLS = [
  'search_web',
  'search_arxiv',
  'search_openalex',
  'search_huggingface_papers',
  'search_crossref',
  'search_semantic_scholar',
  'search_pubmed',
]

const MAX_PARALLEL = 3
let activeSubs = 0

export function canSpawnMore(): boolean {
  return activeSubs < MAX_PARALLEL
}

export async function runSubResearcher(
  opts: SubResearcherOptions,
  executeAnyTool: (name: string, args: any) => string,
): Promise<SubResearcherResult> {
  if (activeSubs >= MAX_PARALLEL) {
    return {
      report: `Error: sub-researcher capacity reached (${MAX_PARALLEL} already running). Wait for earlier ones to finish or sequence them.`,
      iterations: 0,
      sourcesAdded: 0,
      toolCallsMade: [],
    }
  }
  activeSubs++
  try {
    const tracker = getSourceTracker(opts.parentSessionId)
    const startCount = tracker.count()
    const toolCallsMade: string[] = []

    const systemPrompt = `You are a focused sub-researcher. Your job: investigate a single specific question and return a concise, well-cited synthesis.

Task: ${opts.task}

Rules:
- Make at most ${opts.maxIters ?? 6} tool calls total.
- Use only: ${SUB_TOOLS.join(', ')}.
- For each search tool call, use the MINIMAL number of results needed (max_results=5 typically).
- When you have enough, produce a final answer as markdown with sections: Findings, Key Evidence, Open Questions.
- Cite sources by their [N] index (the parent tracker will resolve them).
- Keep the answer under 600 words.
- Do not write files, do not generate images, do not call anything outside the allowed search tools.`

    const messages: any[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Investigate and answer: ${opts.task}` },
    ]

    let finalText = ''
    let iterations = 0
    const maxIter = Math.max(1, Math.min(10, opts.maxIters ?? 6))
    for (let i = 0; i < maxIter; i++) {
      iterations = i + 1
      let response: Response
      try {
        response = await fetch(`${opts.apiUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'local',
            messages,
            temperature: opts.temperature ?? 0.3,
            max_tokens: 1200,
            tools: SUB_TOOLS.map((name) => ({
              type: 'function',
              function: { name, parameters: { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'number' } }, required: ['query'] } },
            })),
          }),
        })
      } catch (e: any) {
        finalText = `Error: sub-researcher LLM request failed: ${e?.message || e}`
        break
      }
      if (!response.ok) {
        finalText = `Error: sub-researcher LLM HTTP ${response.status}`
        break
      }
      const json: any = await response.json()
      const choice = json?.choices?.[0]
      const msg = choice?.message
      if (!msg) { finalText = 'Error: sub-researcher received empty response'; break }
      messages.push(msg)
      const toolCalls = msg.tool_calls
      if (!toolCalls || toolCalls.length === 0) {
        finalText = String(msg.content || '').trim()
        break
      }
      for (const tc of toolCalls) {
        const fn = tc.function || {}
        const name = fn.name || ''
        if (!SUB_TOOLS.includes(name)) {
          messages.push({ role: 'tool', tool_call_id: tc.id, content: `Tool ${name} is not available in sub-researcher mode.` })
          continue
        }
        let args: any = {}
        try { args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : (fn.arguments || {}) } catch { args = {} }
        toolCallsMade.push(name)
        let result: string
        try { result = executeAnyTool(name, args) } catch (e: any) { result = `Error: ${e?.message || e}` }
        try {
          const sources = extractSourcesFromToolResult(name, result)
          if (sources.length > 0) tracker.addMany(sources)
        } catch {}
        const clipped = result.length > 4000 ? result.slice(0, 4000) + '\n… [truncated]' : result
        messages.push({ role: 'tool', tool_call_id: tc.id, content: clipped })
      }
    }

    if (!finalText.trim()) finalText = 'Sub-researcher finished without a final answer.'
    const sourcesAdded = tracker.count() - startCount
    return { report: finalText, iterations, sourcesAdded, toolCallsMade }
  } finally {
    activeSubs--
  }
}
