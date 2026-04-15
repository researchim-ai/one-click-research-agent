import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import * as os from 'os'

const MEMORY_DIR = path.join(os.homedir(), '.one-click-agent', 'memory')

export interface Finding {
  id: string
  timestamp: number
  topic: string
  content: string
  tags: string[]
  sessionId?: string
}

function getWorkspaceMemoryDir(workspacePath: string): string {
  const key = workspacePath
    ? crypto.createHash('sha256').update(path.resolve(workspacePath).toLowerCase()).digest('hex').slice(0, 16)
    : '_global'
  const dir = path.join(MEMORY_DIR, key)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function getLogPath(workspacePath: string): string {
  return path.join(getWorkspaceMemoryDir(workspacePath), 'research-log.jsonl')
}

function getKnowledgePath(workspacePath: string): string {
  return path.join(getWorkspaceMemoryDir(workspacePath), 'knowledge.md')
}

export function saveFinding(
  workspacePath: string,
  topic: string,
  content: string,
  tags?: string,
  sessionId?: string,
): string {
  const trimmedTopic = String(topic ?? '').trim()
  const trimmedContent = String(content ?? '').trim()
  if (!trimmedTopic) return 'Error: topic is required.'
  if (!trimmedContent) return 'Error: content is required.'

  const finding: Finding = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    topic: trimmedTopic,
    content: trimmedContent,
    tags: tags ? String(tags).split(',').map((t) => t.trim()).filter(Boolean) : [],
    sessionId,
  }

  const logPath = getLogPath(workspacePath)
  fs.appendFileSync(logPath, JSON.stringify(finding) + '\n', 'utf-8')

  const knowledgePath = getKnowledgePath(workspacePath)
  const date = new Date(finding.timestamp).toISOString().slice(0, 10)
  const entry = `\n### ${trimmedTopic} (${date})\n${trimmedContent}\n`
  fs.appendFileSync(knowledgePath, entry, 'utf-8')

  return `Finding saved (id: ${finding.id}). Topic: "${trimmedTopic}". Tags: [${finding.tags.join(', ')}].`
}

export function recallFindings(
  workspacePath: string,
  query: string,
  maxResults?: number,
): string {
  const trimmedQuery = String(query ?? '').trim().toLowerCase()
  if (!trimmedQuery) return 'Error: query is required.'

  const logPath = getLogPath(workspacePath)
  if (!fs.existsSync(logPath)) return 'No previous findings stored yet.'

  const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean)
  const limit = Math.max(1, Math.min(20, Number(maxResults) || 10))

  const matches: (Finding & { score: number })[] = []
  const queryTerms = trimmedQuery.split(/\s+/)

  for (const line of lines) {
    try {
      const finding: Finding = JSON.parse(line)
      const searchable = `${finding.topic} ${finding.content} ${finding.tags.join(' ')}`.toLowerCase()
      let score = 0
      for (const term of queryTerms) {
        if (searchable.includes(term)) score++
      }
      if (score > 0) matches.push({ ...finding, score })
    } catch {}
  }

  if (matches.length === 0) return `No findings matching "${trimmedQuery}".`

  matches.sort((a, b) => b.score - a.score || b.timestamp - a.timestamp)
  const top = matches.slice(0, limit)

  const formatted = top.map((f, i) => {
    const date = new Date(f.timestamp).toISOString().slice(0, 10)
    return [
      `${i + 1}. ${f.topic} (${date})`,
      `   Tags: ${f.tags.length ? f.tags.join(', ') : 'none'}`,
      `   ${f.content.slice(0, 500)}${f.content.length > 500 ? '...' : ''}`,
    ].join('\n')
  })

  return `Found ${matches.length} matching finding(s), showing top ${top.length}:\n\n${formatted.join('\n\n')}`
}

export function loadPriorKnowledge(workspacePath: string, maxChars: number): string {
  const knowledgePath = getKnowledgePath(workspacePath)
  if (!fs.existsSync(knowledgePath)) return ''
  try {
    const content = fs.readFileSync(knowledgePath, 'utf-8').trim()
    if (!content) return ''
    const trimmed = content.length > maxChars
      ? content.slice(content.length - maxChars) + '\n...[earlier entries omitted]'
      : content
    return `## Prior Knowledge (from previous sessions)\n${trimmed}`
  } catch { return '' }
}
