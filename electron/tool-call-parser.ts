/**
 * Text-based tool-call parser (fallback path).
 *
 * Native OpenAI-style `tool_calls` from the API are the primary mechanism. Some
 * local models (notably reasoning models like Qwen3) instead emit the call as text
 * in the VISIBLE response, or commit it inside the reasoning channel and leave the
 * visible content empty. This module recovers both shapes.
 *
 * Policy (enforced by the caller in agent.ts, not here): visible tool-call markup is
 * always recovered; reasoning-channel markup is recovered only as a bounded fallback —
 * the caller takes the single LAST call (the model's final decision, not speculative
 * intermediate ones) and relies on the loop guard to short-circuit repeats. This
 * function itself just parses; it returns every match in document order.
 */

export interface ParsedToolCall {
  name: string
  args: Record<string, any>
}

/** Coerce a string argument value recovered from XML into its likely JSON type. */
export function coerceRecoveredToolValue(value: string): any {
  const trimmed = value.trim()
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10)
  if (/^(true|false)$/i.test(trimmed)) return /^true$/i.test(trimmed)
  if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
    try { return JSON.parse(trimmed) } catch {}
  }
  return trimmed
}

/**
 * Extract tool calls written as text. Supports two shapes:
 *  1. XML:  <tool_call><function=NAME><parameter=KEY>VALUE</parameter>...</function></tool_call>
 *  2. JSON: {"name": "tool_name", "arguments": {...}}
 */
export function extractTextToolCalls(content: string): ParsedToolCall[] {
  const results: ParsedToolCall[] = []
  if (!content) return results

  const xmlPattern = /<tool_call>\s*<function=(\w+)>([\s\S]*?)<\/function>\s*<\/tool_call>/g
  let match: RegExpExecArray | null
  while ((match = xmlPattern.exec(content)) !== null) {
    const name = match[1]
    const body = match[2]
    const args: Record<string, any> = {}
    const paramRe = /<parameter=(\w+)>\s*([\s\S]*?)\s*<\/parameter>/g
    let pm: RegExpExecArray | null
    while ((pm = paramRe.exec(body)) !== null) {
      args[pm[1]] = coerceRecoveredToolValue(pm[2].trim())
    }
    if (name) results.push({ name, args })
  }

  const jsonPattern = /\{\s*"name"\s*:\s*"(\w+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\})\s*\}/g
  while ((match = jsonPattern.exec(content)) !== null) {
    try {
      const name = match[1]
      const args = JSON.parse(match[2])
      if (name && typeof args === 'object') results.push({ name, args })
    } catch {}
  }

  return results
}
