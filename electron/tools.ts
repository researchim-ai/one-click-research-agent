import { execFileSync, execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AppConfig, CustomTool } from './config'
import { getWebSearchStatus, loadWebSearchConfig, resolveWebSearchBaseUrl, shouldEnableWebSearchTool } from './searxng'
import { saveFinding, recallFindings } from './memory'
import { getSourceTracker } from './sources'

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the full contents of a file. Always read before editing. Returns line-numbered content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative or absolute file path.' },
          offset: { type: 'number', description: 'Start reading from this line (1-based). Omit to read from beginning.' },
          limit: { type: 'number', description: 'Maximum number of lines to return. Omit to read entire file.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_arxiv',
      description:
        'Search arXiv papers by topic and return structured metadata including title, authors, summary, published date, abstract URL, HTML URL, and PDF URL.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query for arXiv, such as "browser agents" or "protein folding".' },
          max_results: { type: 'number', description: 'Maximum number of papers to return (default: 5, max: 10).' },
          from_date: { type: 'string', description: 'Optional lower bound for submission date, for example "2024-01-01" or "20240101".' },
          to_date: { type: 'string', description: 'Optional upper bound for submission date, for example "2024-12-31" or "20241231".' },
          sort_by: { type: 'string', description: 'Optional sort field: "relevance", "submittedDate", or "lastUpdatedDate".' },
          sort_order: { type: 'string', description: 'Optional sort order: "descending" or "ascending".' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_huggingface_papers',
      description:
        'Search Hugging Face Papers and return paper cards with title, paper URL, arXiv URL, summary, organization, project page, GitHub repo, and popularity signals when available.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query for Hugging Face Papers, such as "agent memory" or "protein language model".' },
          max_results: { type: 'number', description: 'Maximum number of papers to return (default: 5, max: 10).' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_openalex',
      description:
        'Search OpenAlex works and return structured academic results with title, authors, year, venue, citation count, abstract, DOI, and open-access links when available.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Academic search query, such as "in-context reinforcement learning agents" or "diffusion protein design".' },
          max_results: { type: 'number', description: 'Maximum number of papers to return (default: 5, max: 10).' },
          year_from: { type: 'number', description: 'Optional lower bound for publication year.' },
          year_to: { type: 'number', description: 'Optional upper bound for publication year.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'download_arxiv_html',
      description:
        'Download an arXiv paper HTML page into the workspace for local analysis. Prefer this when available; use PDF as fallback.',
      parameters: {
        type: 'object',
        properties: {
          arxiv_id: { type: 'string', description: 'arXiv identifier, for example "2401.01234" or "cs/9308101v1".' },
          output_path: { type: 'string', description: 'Optional relative or absolute output path inside the workspace.' },
        },
        required: ['arxiv_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'download_arxiv_pdf',
      description:
        'Download an arXiv paper PDF into the workspace for local analysis. Use this as a fallback when HTML is unavailable or unsuitable.',
      parameters: {
        type: 'object',
        properties: {
          arxiv_id: { type: 'string', description: 'arXiv identifier, for example "2401.01234" or "cs/9308101v1".' },
          output_path: { type: 'string', description: 'Optional relative or absolute output path inside the workspace.' },
        },
        required: ['arxiv_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description:
        'Search the web through a configured SearXNG instance and return structured results with titles, URLs, snippets, engines, and optional dates.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Web search query, such as "Qwen3.5-35B-A3B github repo" or "browser agents benchmark".' },
          max_results: { type: 'number', description: 'Maximum number of results to return (default: 5, max: 10).' },
          categories: { type: 'string', description: 'Optional SearXNG categories, for example "general", "science", "it", or comma-separated values.' },
          language: { type: 'string', description: 'Optional search language, for example "en" or "ru".' },
          time_range: { type: 'string', description: 'Optional time range such as "day", "month", or "year".' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reflect',
      description: 'Critically self-evaluate your current findings and reasoning. Call this after synthesizing search results to check for gaps, contradictions, unsupported claims, and missing perspectives before presenting conclusions to the user.',
      parameters: {
        type: 'object',
        properties: {
          findings: { type: 'string', description: 'Your current findings or conclusions to evaluate.' },
          criteria: {
            type: 'string',
            description: 'Comma-separated evaluation criteria. Options: completeness, accuracy, contradictions, gaps, bias, recency. Default: all.',
          },
        },
        required: ['findings'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_finding',
      description: 'Save a key research finding to persistent memory. Findings persist across sessions and can be recalled later. Use this to preserve important conclusions, discovered facts, or insights.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Short topic title for this finding, e.g. "SOTA protein language models 2025".' },
          content: { type: 'string', description: 'The finding content — key facts, conclusions, or insights to remember.' },
          tags: { type: 'string', description: 'Optional comma-separated tags for categorization, e.g. "ml,proteins,survey".' },
        },
        required: ['topic', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall_findings',
      description: 'Search persistent memory for previously saved research findings. Returns matching findings from prior sessions ranked by relevance.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query to find relevant past findings.' },
          max_results: { type: 'number', description: 'Maximum results to return (default: 10, max: 20).' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_report',
      description: 'Generate a structured research report as a Markdown file. Automatically appends a References section from all sources collected during this session. Use this as the final step of a deep research workflow.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Report title.' },
          content: { type: 'string', description: 'Full report body in Markdown. Use [1], [2] etc. to cite collected sources — they will be resolved automatically in the References section.' },
          output_path: { type: 'string', description: 'Output file path relative to workspace (default: .research/report.md).' },
          session_id: { type: 'string', description: 'Internal: session ID for source tracker. Passed automatically.' },
        },
        required: ['title', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a new file or completely overwrite an existing one. For partial edits, use edit_file instead.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path.' },
          content: { type: 'string', description: 'Full file content.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Make a targeted edit to a file by replacing an exact string match. ' +
        'You MUST read the file first to know the exact content. ' +
        'Provide old_string (the exact text to find) and new_string (the replacement). ' +
        'old_string must match EXACTLY including whitespace and indentation. ' +
        'For multiple edits in one file, call this tool multiple times.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path.' },
          old_string: { type: 'string', description: 'The exact string to find and replace. Must be unique in the file.' },
          new_string: { type: 'string', description: 'The replacement string. Use empty string to delete.' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description:
        'List files and directories in a tree-like format. ' +
        'Shows directory structure up to specified depth. Ignores node_modules, .git, __pycache__, dist, build by default.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path. Defaults to workspace root.' },
          depth: { type: 'number', description: 'Max recursion depth (default: 3).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_files',
      description: 'Find files by name pattern (glob) or content (regex). Returns matching file paths.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern for filenames (e.g. "*.tsx", "src/**/*.py") or text to search inside files.' },
          type: {
            type: 'string',
            enum: ['name', 'content'],
            description: '"name" to match file names, "content" to search inside files (using ripgrep).',
          },
          path: { type: 'string', description: 'Directory to search in. Defaults to workspace root.' },
        },
        required: ['pattern', 'type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_command',
      description:
        'Run a shell command and return stdout + stderr. ' +
        'Use for: running tests, installing dependencies, git operations, build commands, etc. ' +
        'Commands run in the workspace directory by default. Timeout: 120 seconds. ' +
        'IMPORTANT: Use OS-appropriate commands (see system prompt for current OS).',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute.' },
          working_directory: { type: 'string', description: 'Working directory (relative to workspace). Defaults to workspace root.' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_directory',
      description: 'Create a directory (and any parent directories).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to create.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_file',
      description:
        'Append content to the end of an existing file. Use this to build large files incrementally: ' +
        'first create the file skeleton with write_file, then append sections with this tool. ' +
        'If the file does not exist, it will be created.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path.' },
          content: { type: 'string', description: 'Content to append.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a single file. Cannot delete directories — use execute_command to remove directories.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to delete.' },
        },
        required: ['path'],
      },
    },
  },
]

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.next', '.nuxt',
  'dist', 'build', '.cache', '.venv', 'venv', 'env',
  '.tox', 'coverage', '.nyc_output', '.turbo', 'target',
])

function resolvePath(raw: string | undefined, workspace: string): string {
  if (!raw) return workspace
  const p = path.isAbsolute(raw) ? raw : path.join(workspace, raw)
  return path.resolve(p)
}

function assertInWorkspace(resolved: string, workspace: string): void {
  const ws = path.resolve(workspace)
  if (!resolved.startsWith(ws) && !resolved.startsWith(ws + path.sep)) {
    throw new Error(`Access denied: ${resolved} is outside workspace ${ws}`)
  }
}

export function executeTool(name: string, args: Record<string, any>, workspace: string): string {
  if (!workspace) return 'Error: workspace not set. Please set a workspace directory first.'
  try {
    switch (name) {
      case 'read_file':
        return readFile(args.path, workspace, args.offset, args.limit)
      case 'write_file':
        return writeFile(args.path, args.content, workspace)
      case 'search_arxiv':
        return searchArxiv(args.query, args.max_results, args.from_date, args.to_date, args.sort_by, args.sort_order)
      case 'search_huggingface_papers':
        return searchHuggingFacePapers(args.query, args.max_results)
      case 'search_openalex':
        return searchOpenAlex(args.query, args.max_results, args.year_from, args.year_to)
      case 'search_web':
        return searchWeb(args.query, args.max_results, args.categories, args.language, args.time_range)
      case 'download_arxiv_html':
        return downloadArxivHtml(args.arxiv_id, args.output_path, workspace)
      case 'download_arxiv_pdf':
        return downloadArxivPdf(args.arxiv_id, args.output_path, workspace)
      case 'edit_file':
        return editFile(args.path, args.old_string, args.new_string, workspace)
      case 'append_file':
        return appendFile(args.path, args.content, workspace)
      case 'list_directory':
        return listDir(args.path, workspace, args.depth ?? 3)
      case 'find_files':
        return findFiles(args.pattern, args.type ?? 'name', args.path, workspace)
      case 'execute_command':
        return execCommand(args.command, args.working_directory, workspace)
      case 'create_directory':
        return createDir(args.path, workspace)
      case 'delete_file':
        return deleteFile(args.path, workspace)
      case 'reflect':
        return reflectOnFindings(args.findings, args.criteria)
      case 'save_finding':
        return saveFinding(workspace, args.topic, args.content, args.tags)
      case 'recall_findings':
        return recallFindings(workspace, args.query, args.max_results)
      case 'generate_report':
        return generateReport(args.title, args.content, args.output_path, args.session_id, workspace)
      default:
        return `Unknown tool: ${name}`
    }
  } catch (e: any) {
    return `Error: ${e.message}`
  }
}

function readFile(filePath: string, workspace: string, offset?: number, limit?: number): string {
  const p = resolvePath(filePath, workspace)
  assertInWorkspace(p, workspace)
  if (!fs.existsSync(p)) return `File not found: ${filePath}`
  const stat = fs.statSync(p)
  if (stat.isDirectory()) return `Error: ${filePath} is a directory, not a file. Use list_directory instead.`

  const lines = fs.readFileSync(p, 'utf-8').split('\n')
  const total = lines.length

  const start = Math.max(0, (offset ?? 1) - 1)
  const end = limit ? Math.min(start + limit, total) : total
  const slice = lines.slice(start, end)

  const padWidth = String(end).length
  const numbered = slice.map((line, i) => {
    const lineNum = String(start + i + 1).padStart(padWidth, ' ')
    return `${lineNum}|${line}`
  })

  let result = numbered.join('\n')
  if (result.length > 100000) result = result.slice(0, 100000) + '\n… [truncated]'

  const header = `[${filePath}] (${total} lines)`
  if (start > 0 || end < total) {
    return `${header} showing lines ${start + 1}-${end}:\n${result}`
  }
  return `${header}\n${result}`
}

function writeFile(filePath: string, content: string, workspace: string): string {
  const p = resolvePath(filePath, workspace)
  assertInWorkspace(p, workspace)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
  const lines = content.split('\n').length
  return `Created ${filePath} (${lines} lines, ${content.length} bytes)`
}

function runNodeScript(source: string, args: string[]): string {
  return execFileSync(process.execPath, ['-e', source, ...args], {
    encoding: 'utf-8',
    timeout: 120000,
    maxBuffer: 1024 * 1024 * 10,
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      ELECTRON_RUN_AS_NODE: '1',
    },
  })
}

function normalizeArxivId(input: string): string {
  return String(input ?? '')
    .trim()
    .replace(/\.pdf$/i, '')
    .replace(/\/abs\//, '')
    .replace(/\/html\//, '')
    .replace(/\/pdf\//, '')
    .replace(/^https?:\/\/arxiv\.org\/abs\//i, '')
    .replace(/^https?:\/\/arxiv\.org\/html\//i, '')
    .replace(/^https?:\/\/arxiv\.org\/pdf\//i, '')
}

export function getBuiltinToolDefinitions(cfg?: Pick<AppConfig, 'webSearchProvider' | 'searxngBaseUrl'> | null): typeof TOOL_DEFINITIONS {
  const searchEnabled = shouldEnableWebSearchTool({
    webSearchProvider: cfg?.webSearchProvider ?? (cfg?.searxngBaseUrl ? 'custom-searxng' : 'disabled'),
    searxngBaseUrl: cfg?.searxngBaseUrl ?? null,
  })
  return TOOL_DEFINITIONS.filter((tool) => tool.function.name !== 'search_web' || searchEnabled)
}

function escapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractXmlTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return match ? escapeXml(match[1]) : ''
}

function extractXmlTags(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi'))].map((match) => escapeXml(match[1]))
}

function clampSearchLimit(maxResults: number | undefined): number {
  return Math.max(1, Math.min(10, Number(maxResults) || 5))
}

function formatDateToYmd(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

function detectFreshnessHints(rawQuery: string): {
  freshness: boolean
  today: boolean
  week: boolean
  month: boolean
  year: boolean
} {
  const q = String(rawQuery ?? '').toLowerCase()
  const freshness = /(latest|recent|newest|fresh|today|this week|this month|this year|last week|last month|последн|свеж|новейш|сегодня|свежие|за сегодня|за неделю|за месяц|на этой неделе|в этом месяце|в этом году)/.test(q)
  return {
    freshness,
    today: /(today|сегодня|за сегодня)/.test(q),
    week: /(this week|last week|за неделю|на этой неделе)/.test(q),
    month: /(this month|last month|за месяц|в этом месяце)/.test(q),
    year: /(this year|в этом году|за год)/.test(q),
  }
}

function inferDateWindow(rawQuery: string): { fromDate: string | null; toDate: string | null; freshness: boolean } {
  const hints = detectFreshnessHints(rawQuery)
  const now = new Date()
  if (hints.today) {
    const ymd = formatDateToYmd(now)
    return { fromDate: ymd, toDate: ymd, freshness: true }
  }
  if (hints.week) {
    const from = new Date(now)
    from.setDate(now.getDate() - 7)
    return { fromDate: formatDateToYmd(from), toDate: formatDateToYmd(now), freshness: true }
  }
  if (hints.month) {
    const from = new Date(now.getFullYear(), now.getMonth(), 1)
    return { fromDate: formatDateToYmd(from), toDate: formatDateToYmd(now), freshness: true }
  }
  if (hints.year) {
    const from = new Date(now.getFullYear(), 0, 1)
    return { fromDate: formatDateToYmd(from), toDate: formatDateToYmd(now), freshness: true }
  }
  return { fromDate: null, toDate: null, freshness: hints.freshness }
}

function isFreshnessOnlyQuery(rawQuery: string): boolean {
  const stripped = String(rawQuery ?? '')
    .replace(/latest|recent|newest|fresh|today|this week|this month|this year|last week|last month|papers?|articles?|стат(ьи|ей|ья)|последн\w*|свеж\w*|новейш\w*|сегодня|за сегодня|за неделю|за месяц|на этой неделе|в этом месяце|в этом году/gi, '')
    .trim()
  return stripped.length === 0 || !/[a-zа-я0-9]{4,}/i.test(stripped)
}

function normalizeIsoDate(value: string | undefined): string | null {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return null
  if (/^\d{8}$/.test(trimmed)) return trimmed
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  return `${match[1]}${match[2]}${match[3]}`
}

function generateReport(
  title: string,
  content: string,
  outputPath: string | undefined,
  sessionId: string | undefined,
  workspace: string,
): string {
  const trimmedTitle = String(title ?? '').trim()
  if (!trimmedTitle) return 'Error: title is required.'
  const trimmedContent = String(content ?? '').trim()
  if (!trimmedContent) return 'Error: content is required.'

  const targetPath = resolvePath(outputPath || '.research/report.md', workspace)
  assertInWorkspace(targetPath, workspace)
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })

  let references = ''
  if (sessionId) {
    try {
      const tracker = getSourceTracker(sessionId)
      const refText = tracker.formatForReport()
      if (refText) references = `\n\n---\n\n## References\n\n${refText}\n`
    } catch {}
  }

  const date = new Date().toISOString().slice(0, 10)
  const report = `# ${trimmedTitle}\n\n*Generated: ${date}*\n\n${trimmedContent}${references}\n`

  fs.writeFileSync(targetPath, report, 'utf-8')
  const relPath = path.relative(workspace, targetPath)
  return `Report saved to ${relPath} (${report.length} chars, ${references ? 'with' : 'without'} references section).`
}

function reflectOnFindings(findings: string, criteria?: string): string {
  const trimmed = String(findings ?? '').trim()
  if (!trimmed) return 'Error: findings text is required.'

  const allCriteria = ['completeness', 'accuracy', 'contradictions', 'gaps', 'bias', 'recency']
  const requested = criteria
    ? String(criteria).split(',').map((c) => c.trim().toLowerCase()).filter((c) => allCriteria.includes(c))
    : allCriteria
  if (requested.length === 0) requested.push(...allCriteria)

  const checklist: string[] = [
    '## Self-Reflection Checklist\n',
    'Evaluate the findings below against each criterion. For each, note whether the findings PASS, NEED IMPROVEMENT, or FAIL, and explain why.\n',
    `### Findings under review\n${trimmed.slice(0, 2000)}${trimmed.length > 2000 ? '\n...[truncated]' : ''}\n`,
  ]

  const criteriaDescriptions: Record<string, string> = {
    completeness: 'Are all aspects of the research question addressed? Are there sub-topics that were not explored?',
    accuracy: 'Are claims supported by the cited sources? Are there unsupported assertions presented as facts?',
    contradictions: 'Do any findings contradict each other? Are conflicting viewpoints acknowledged and resolved?',
    gaps: 'What important information is missing? What follow-up searches or analyses would strengthen the conclusions?',
    bias: 'Is the evidence one-sided? Are alternative perspectives represented? Is there selection bias in sources?',
    recency: 'Are the sources up-to-date for this topic? Are there more recent developments that should be included?',
  }

  for (const c of requested) {
    checklist.push(`### ${c.charAt(0).toUpperCase() + c.slice(1)}`)
    checklist.push(`${criteriaDescriptions[c]}\n`)
    checklist.push(`- [ ] Verdict: ___\n- [ ] Notes: ___\n`)
  }

  checklist.push('### Action Items')
  checklist.push('Based on the above evaluation, list specific next steps to improve the research quality before presenting final conclusions.\n')

  return checklist.join('\n')
}

function searchArxiv(
  query: string,
  maxResults?: number,
  fromDate?: string,
  toDate?: string,
  sortBy?: string,
  sortOrder?: string,
): string {
  const trimmedQuery = String(query ?? '').trim()
  if (!trimmedQuery) return 'Error: query is required.'

  const limit = clampSearchLimit(maxResults)
  const inferredWindow = inferDateWindow(trimmedQuery)
  const freshnessHints = detectFreshnessHints(trimmedQuery)
  const normalizedFrom = normalizeIsoDate(fromDate) ?? inferredWindow.fromDate
  const normalizedTo = normalizeIsoDate(toDate) ?? inferredWindow.toDate
  if (fromDate && !normalizedFrom) return 'Error: from_date must be in YYYY-MM-DD or YYYYMMDD format.'
  if (toDate && !normalizedTo) return 'Error: to_date must be in YYYY-MM-DD or YYYYMMDD format.'

  const safeSortBy = ['relevance', 'submittedDate', 'lastUpdatedDate'].includes(String(sortBy ?? ''))
    ? String(sortBy)
    : inferredWindow.freshness ? 'submittedDate' : 'relevance'
  const safeSortOrder = ['ascending', 'descending'].includes(String(sortOrder ?? ''))
    ? String(sortOrder)
    : 'descending'
  const dateFilter = (normalizedFrom || normalizedTo)
    ? ` AND submittedDate:[${normalizedFrom ? normalizedFrom + '0000' : '*'} TO ${normalizedTo ? normalizedTo + '2359' : '*'}]`
    : ''
  const script = `
const query = process.argv[1]
const limit = Number(process.argv[2] || '5')
const sortBy = process.argv[3] || 'relevance'
const sortOrder = process.argv[4] || 'descending'
const dateFilter = process.argv[5] || ''
const searchQuery = dateFilter ? '(all:' + query + ')' + dateFilter : 'all:' + query
const url = 'http://export.arxiv.org/api/query?search_query=' + encodeURIComponent(searchQuery) + '&start=0&max_results=' + limit + '&sortBy=' + encodeURIComponent(sortBy) + '&sortOrder=' + encodeURIComponent(sortOrder)
fetch(url, {
  headers: { 'User-Agent': 'one-click-research-agent/0.1' },
}).then(async (res) => {
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const text = await res.text()
  process.stdout.write(text)
}).catch((err) => {
  console.error(String(err?.message || err))
  process.exit(1)
})
`

  let xml = ''
  try {
    xml = runNodeScript(script, [trimmedQuery, String(limit), safeSortBy, safeSortOrder, dateFilter])
  } catch (e: any) {
    const stderr = String(e?.stderr || e?.message || e)
    return `Error: failed to search arXiv. ${stderr.trim()}`
  }

  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((match) => match[1]).slice(0, limit)
  if (entries.length === 0) return `No arXiv papers found for "${trimmedQuery}".`

  const lines = entries.map((entry, idx) => {
    const idUrl = extractXmlTag(entry, 'id')
    const id = idUrl.split('/abs/').pop() || idUrl
    const normalizedId = normalizeArxivId(id)
    const title = extractXmlTag(entry, 'title')
    const summary = extractXmlTag(entry, 'summary')
    const published = extractXmlTag(entry, 'published')
    const authors = extractXmlTags(entry, 'name').join(', ')
    const categories = [...entry.matchAll(/<category[^>]*term="([^"]+)"/gi)].map((match) => match[1]).join(', ')
    const absUrl = `https://arxiv.org/abs/${normalizedId}`
    const htmlUrl = `https://arxiv.org/html/${normalizedId}`
    const pdfUrl = `https://arxiv.org/pdf/${normalizedId.replace(/v\\d+$/, '')}.pdf`
    return [
      `${idx + 1}. ${title}`,
      `   arXiv ID: ${normalizedId}`,
      `   Authors: ${authors || 'Unknown'}`,
      `   Published: ${published || 'Unknown'}`,
      `   Categories: ${categories || 'Unknown'}`,
      `   Abstract: ${absUrl}`,
      `   HTML: ${htmlUrl}`,
      `   PDF: ${pdfUrl}`,
      `   Summary: ${summary || 'No summary available.'}`,
    ].join('\n')
  })

  const filters: string[] = []
  if (normalizedFrom) filters.push(`from ${normalizedFrom.slice(0, 4)}-${normalizedFrom.slice(4, 6)}-${normalizedFrom.slice(6, 8)}`)
  if (normalizedTo) filters.push(`to ${normalizedTo.slice(0, 4)}-${normalizedTo.slice(4, 6)}-${normalizedTo.slice(6, 8)}`)
  filters.push(`sort ${safeSortBy} ${safeSortOrder}`)
  return `Found ${entries.length} arXiv paper(s) for "${trimmedQuery}" (${filters.join(', ')}):\n\n${lines.join('\n\n')}`
}

function searchWeb(
  query: string,
  maxResults: number | undefined,
  categories: string | undefined,
  language: string | undefined,
  timeRange: string | undefined,
): string {
  const trimmedQuery = String(query ?? '').trim()
  if (!trimmedQuery) return 'Error: query is required.'

  const webSearchCfg = loadWebSearchConfig()
  let searxngBaseUrl: string | null = null
  try {
    searxngBaseUrl = resolveWebSearchBaseUrl(webSearchCfg, true)
  } catch (e: any) {
    const message = String(e?.message || e).trim()
    return `Error: failed to prepare SearXNG backend. ${message}`
  }
  if (!searxngBaseUrl) {
    const status = getWebSearchStatus(webSearchCfg)
    return `Error: web search is unavailable. ${status.detail}`
  }

  const inferredWindow = inferDateWindow(trimmedQuery)
  const freshnessHints = detectFreshnessHints(trimmedQuery)
  const limit = Math.max(1, Math.min(10, Number(maxResults) || 5))
  const params = new URLSearchParams({
    q: trimmedQuery,
    format: 'json',
  })
  if (categories && String(categories).trim()) params.set('categories', String(categories).trim())
  if (language && String(language).trim()) params.set('language', String(language).trim())
  const effectiveTimeRange = String(timeRange ?? '').trim()
    || (freshnessHints.today ? 'day' : freshnessHints.week || freshnessHints.month ? 'month' : freshnessHints.year ? 'year' : '')
  if (effectiveTimeRange) params.set('time_range', effectiveTimeRange)

  const script = `
const baseUrl = process.argv[1]
const queryString = process.argv[2]
fetch(baseUrl + '/search?' + queryString, {
  headers: { 'User-Agent': 'one-click-research-agent/0.1', Accept: 'application/json' },
}).then(async (res) => {
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const json = await res.json()
  process.stdout.write(JSON.stringify(json))
}).catch((err) => {
  console.error(String(err?.message || err))
  process.exit(1)
})
`

  let payload: any
  try {
    const out = runNodeScript(script, [searxngBaseUrl, params.toString()])
    payload = JSON.parse(out)
  } catch (e: any) {
    const stderr = String(e?.stderr || e?.message || e).trim()
    return `Error: failed to search via SearXNG. ${stderr}`
  }

  const results = Array.isArray(payload?.results) ? payload.results.slice(0, limit) : []
  if (results.length === 0) return `No web results found for "${trimmedQuery}".`

  const lines = results.map((entry: any, idx: number) => {
    const title = String(entry?.title || 'Untitled').trim()
    const url = String(entry?.url || entry?.link || '').trim()
    const snippet = String(entry?.content || entry?.snippet || '').replace(/\s+/g, ' ').trim()
    const engines = Array.isArray(entry?.engines)
      ? entry.engines.join(', ')
      : String(entry?.engine || entry?.source || entry?.category || '').trim()
    const published = String(entry?.publishedDate || entry?.published || entry?.date || '').trim()
    return [
      `${idx + 1}. ${title}`,
      url ? `   URL: ${url}` : null,
      engines ? `   Engines: ${engines}` : null,
      published ? `   Published: ${published}` : null,
      snippet ? `   Snippet: ${snippet}` : null,
    ].filter(Boolean).join('\n')
  })

  return `Found ${results.length} web result(s) for "${trimmedQuery}"${effectiveTimeRange ? ` (time_range=${effectiveTimeRange})` : ''}:\n\n${lines.join('\n\n')}`
}

function searchHuggingFacePapers(query: string, maxResults?: number): string {
  const trimmedQuery = String(query ?? '').trim()
  if (!trimmedQuery) return 'Error: query is required.'

  const limit = clampSearchLimit(maxResults)
  const inferredWindow = inferDateWindow(trimmedQuery)
  const script = `
const query = process.argv[1]
const limit = Number(process.argv[2] || '5')
const latestMode = process.argv[3] === '1'
function decodeHtmlText(text) {
  return String(text || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}
function extractObjects(text, limit) {
  const marker = '{"paper":{"id":"'
  const out = []
  let index = 0
  while (out.length < limit && (index = text.indexOf(marker, index)) !== -1) {
    let depth = 0
    let inString = false
    let escaped = false
    let end = -1
    for (let i = index; i < text.length; i++) {
      const ch = text[i]
      if (escaped) { escaped = false; continue }
      if (ch === '\\\\' && inString) { escaped = true; continue }
      if (ch === '"') { inString = !inString; continue }
      if (inString) continue
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) { end = i + 1; break }
      }
    }
    if (end <= index) break
    try {
      const obj = JSON.parse(text.slice(index, end))
      if (obj && obj.paper && obj.paper.id) out.push(obj)
    } catch {}
    index = end
  }
  return out
}
const url = latestMode ? 'https://huggingface.co/papers' : 'https://huggingface.co/papers?q=' + encodeURIComponent(query)
fetch(url, {
  headers: { 'User-Agent': 'one-click-research-agent/0.1' },
}).then(async (res) => {
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const html = decodeHtmlText(await res.text())
  process.stdout.write(JSON.stringify(extractObjects(html, limit)))
}).catch((err) => {
  console.error(String(err?.message || err))
  process.exit(1)
})
`

  let items: any[] = []
  try {
    const freshnessOnly = inferredWindow.freshness && isFreshnessOnlyQuery(trimmedQuery)
    const out = runNodeScript(script, [trimmedQuery, String(limit), freshnessOnly ? '1' : '0'])
    items = JSON.parse(out)
  } catch (e: any) {
    const stderr = String(e?.stderr || e?.message || e).trim()
    return `Error: failed to search Hugging Face Papers. ${stderr}`
  }

  if (!Array.isArray(items) || items.length === 0) {
    return `No Hugging Face Papers results found for "${trimmedQuery}".`
  }

  const lines = items.slice(0, limit).map((entry: any, idx: number) => {
    const paper = entry?.paper ?? {}
    const title = String(entry?.title || paper?.title || 'Untitled').trim()
    const paperId = String(paper?.id || '').trim()
    const summary = String(entry?.summary || paper?.summary || '').replace(/\s+/g, ' ').trim()
    const org = String(entry?.organization?.fullname || entry?.organization?.name || paper?.organization?.fullname || '').trim()
    const projectPage = String(paper?.projectPage || '').trim()
    const githubRepo = String(paper?.githubRepo || '').trim()
    const published = String(entry?.publishedAt || paper?.publishedAt || '').trim()
    const upvotes = Number.isFinite(Number(paper?.upvotes)) ? String(paper.upvotes) : ''
    const comments = Number.isFinite(Number(entry?.numComments)) ? String(entry.numComments) : ''
    const authors = Array.isArray(paper?.authors)
      ? paper.authors.map((author: any) => String(author?.name || '').trim()).filter(Boolean).slice(0, 8).join(', ')
      : ''
    const paperUrl = paperId ? `https://huggingface.co/papers/${paperId}` : ''
    const arxivUrl = paperId ? `https://arxiv.org/abs/${paperId}` : ''
    return [
      `${idx + 1}. ${title}`,
      paperId ? `   Paper ID: ${paperId}` : null,
      paperUrl ? `   Hugging Face: ${paperUrl}` : null,
      arxivUrl ? `   arXiv: ${arxivUrl}` : null,
      projectPage ? `   Project: ${projectPage}` : null,
      githubRepo ? `   GitHub: ${githubRepo}` : null,
      org ? `   Organization: ${org}` : null,
      authors ? `   Authors: ${authors}` : null,
      published ? `   Published: ${published}` : null,
      upvotes ? `   Upvotes: ${upvotes}` : null,
      comments ? `   Comments: ${comments}` : null,
      summary ? `   Summary: ${summary}` : null,
    ].filter(Boolean).join('\n')
  })

  return `Found ${Math.min(items.length, limit)} Hugging Face Papers result(s) for "${trimmedQuery}":\n\n${lines.join('\n\n')}`
}

function searchOpenAlex(query: string, maxResults?: number, yearFrom?: number, yearTo?: number): string {
  const trimmedQuery = String(query ?? '').trim()
  if (!trimmedQuery) return 'Error: query is required.'

  const limit = clampSearchLimit(maxResults)
  const inferredWindow = inferDateWindow(trimmedQuery)
  const inferredMinYear = inferredWindow.fromDate ? Number(inferredWindow.fromDate.slice(0, 4)) : null
  const inferredMaxYear = inferredWindow.toDate ? Number(inferredWindow.toDate.slice(0, 4)) : null
  const minYear = Number.isFinite(Number(yearFrom)) ? Math.trunc(Number(yearFrom)) : inferredMinYear
  const maxYear = Number.isFinite(Number(yearTo)) ? Math.trunc(Number(yearTo)) : inferredMaxYear
  if (minYear !== null && (minYear < 1900 || minYear > 2100)) return 'Error: year_from must be between 1900 and 2100.'
  if (maxYear !== null && (maxYear < 1900 || maxYear > 2100)) return 'Error: year_to must be between 1900 and 2100.'
  if (minYear !== null && maxYear !== null && minYear > maxYear) return 'Error: year_from cannot be greater than year_to.'

  const params = new URLSearchParams()
  const freshnessOnly = inferredWindow.freshness && isFreshnessOnlyQuery(trimmedQuery)
  if (!freshnessOnly) params.set('search', trimmedQuery)
  const filters: string[] = []
  if (inferredWindow.fromDate) filters.push(`from_publication_date:${inferredWindow.fromDate.slice(0, 4)}-${inferredWindow.fromDate.slice(4, 6)}-${inferredWindow.fromDate.slice(6, 8)}`)
  else if (minYear !== null) filters.push(`from_publication_date:${minYear}-01-01`)
  if (inferredWindow.toDate) filters.push(`to_publication_date:${inferredWindow.toDate.slice(0, 4)}-${inferredWindow.toDate.slice(4, 6)}-${inferredWindow.toDate.slice(6, 8)}`)
  else if (maxYear !== null) filters.push(`to_publication_date:${maxYear}-12-31`)
  if (filters.length > 0) params.set('filter', filters.join(','))
  params.set('per_page', String(limit))
  if (inferredWindow.freshness) params.set('sort', 'publication_date:desc')

  const script = `
const url = 'https://api.openalex.org/works?' + process.argv[1]
fetch(url, {
  headers: { 'User-Agent': 'one-click-research-agent/0.1', Accept: 'application/json' },
}).then(async (res) => {
  if (!res.ok) throw new Error('HTTP ' + res.status)
  process.stdout.write(JSON.stringify(await res.json()))
}).catch((err) => {
  console.error(String(err?.message || err))
  process.exit(1)
})
`

  let payload: any
  try {
    payload = JSON.parse(runNodeScript(script, [params.toString()]))
  } catch (e: any) {
    const stderr = String(e?.stderr || e?.message || e).trim()
    return `Error: failed to search OpenAlex. ${stderr}`
  }

  const items = Array.isArray(payload?.results) ? payload.results.slice(0, limit) : []
  if (items.length === 0) return `No OpenAlex papers found for "${trimmedQuery}".`

  const lines = items.map((entry: any, idx: number) => {
    const title = String(entry?.display_name || entry?.title || 'Untitled').trim()
    const url = String(entry?.id || '').trim()
    const doi = String(entry?.doi || '').trim()
    const landingPage = String(entry?.primary_location?.landing_page_url || '').trim()
    const openAccessPdf = String(entry?.primary_location?.pdf_url || '').trim()
    const year = entry?.publication_year ? String(entry.publication_year) : ''
    const venue = String(entry?.primary_location?.source?.display_name || '').trim()
    const publicationDate = String(entry?.publication_date || '').trim()
    const citationCount = Number.isFinite(Number(entry?.cited_by_count)) ? String(entry.cited_by_count) : ''
    const abstract = entry?.abstract_inverted_index
      ? Object.entries(entry.abstract_inverted_index as Record<string, number[]>)
          .flatMap(([word, positions]) => (positions as number[]).map((pos) => [pos, word] as const))
          .sort((a, b) => a[0] - b[0])
          .map(([, word]) => word)
          .join(' ')
      : ''
    const authors = Array.isArray(entry?.authorships)
      ? entry.authorships.map((authorship: any) => String(authorship?.author?.display_name || '').trim()).filter(Boolean).slice(0, 10).join(', ')
      : ''
    const fieldsOfStudy = Array.isArray(entry?.concepts)
      ? entry.concepts.map((concept: any) => String(concept?.display_name || '').trim()).filter(Boolean).slice(0, 6).join(', ')
      : ''
    return [
      `${idx + 1}. ${title}`,
      year ? `   Year: ${year}` : null,
      venue ? `   Venue: ${venue}` : null,
      publicationDate ? `   Published: ${publicationDate}` : null,
      authors ? `   Authors: ${authors}` : null,
      citationCount ? `   Citations: ${citationCount}` : null,
      fieldsOfStudy ? `   Fields: ${fieldsOfStudy}` : null,
      url ? `   OpenAlex: ${url}` : null,
      doi ? `   DOI: ${doi}` : null,
      landingPage ? `   Landing Page: ${landingPage}` : null,
      openAccessPdf ? `   Open PDF: ${openAccessPdf}` : null,
      abstract ? `   Abstract: ${abstract.replace(/\s+/g, ' ').trim()}` : null,
    ].filter(Boolean).join('\n')
  })

  const filterText = inferredWindow.fromDate || inferredWindow.toDate
    ? `, dates ${inferredWindow.fromDate ? `${inferredWindow.fromDate.slice(0, 4)}-${inferredWindow.fromDate.slice(4, 6)}-${inferredWindow.fromDate.slice(6, 8)}` : '*'}..${inferredWindow.toDate ? `${inferredWindow.toDate.slice(0, 4)}-${inferredWindow.toDate.slice(4, 6)}-${inferredWindow.toDate.slice(6, 8)}` : '*'}`
    : minYear !== null || maxYear !== null
      ? `, years ${minYear ?? '*'}-${maxYear ?? '*'}`
      : ''
  return `Found ${items.length} OpenAlex paper(s) for "${trimmedQuery}"${filterText}:\n\n${lines.join('\n\n')}`
}

function downloadArxivHtml(arxivId: string, outputPath: string | undefined, workspace: string): string {
  const trimmedId = String(arxivId ?? '').trim()
  if (!trimmedId) return 'Error: arxiv_id is required.'

  const normalizedId = normalizeArxivId(trimmedId)
  const safeId = normalizedId.replace(/\//g, '_')
  const targetPath = resolvePath(outputPath || path.join('.research', 'arxiv', `${safeId}.html`), workspace)
  assertInWorkspace(targetPath, workspace)
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })

  const htmlUrl = `https://arxiv.org/html/${normalizedId}`
  const script = `
const url = process.argv[1]
const outPath = process.argv[2]
fetch(url, {
  headers: { 'User-Agent': 'one-click-research-agent/0.1' },
}).then(async (res) => {
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const text = await res.text()
  require('fs').writeFileSync(outPath, text, 'utf-8')
  process.stdout.write(String(text.length))
}).catch((err) => {
  console.error(String(err?.message || err))
  process.exit(1)
})
`

  let charCount = 0
  try {
    const out = runNodeScript(script, [htmlUrl, targetPath]).trim()
    charCount = Number(out) || fs.readFileSync(targetPath, 'utf-8').length
  } catch (e: any) {
    const stderr = String(e?.stderr || e?.message || e).trim()
    if (stderr.includes('HTTP 404')) {
      return `Error: arXiv HTML is not available for ${normalizedId}. Use download_arxiv_pdf as a fallback.`
    }
    return `Error: failed to download arXiv HTML. ${stderr}`
  }

  return `Downloaded arXiv HTML ${normalizedId} to ${path.relative(workspace, targetPath) || targetPath} (${charCount} chars)`
}

function downloadArxivPdf(arxivId: string, outputPath: string | undefined, workspace: string): string {
  const trimmedId = String(arxivId ?? '').trim()
  if (!trimmedId) return 'Error: arxiv_id is required.'

  const normalizedId = normalizeArxivId(trimmedId)
  const safeId = normalizedId.replace(/\//g, '_')
  const targetPath = resolvePath(outputPath || path.join('.research', 'arxiv', `${safeId}.pdf`), workspace)
  assertInWorkspace(targetPath, workspace)
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })

  const pdfUrl = `https://arxiv.org/pdf/${normalizedId.replace(/v\d+$/, '')}.pdf`

  const script = `
const url = process.argv[1]
const outPath = process.argv[2]
fetch(url, {
  headers: { 'User-Agent': 'one-click-research-agent/0.1' },
}).then(async (res) => {
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const arr = new Uint8Array(await res.arrayBuffer())
  require('fs').writeFileSync(outPath, Buffer.from(arr))
  process.stdout.write(String(arr.byteLength))
}).catch((err) => {
  console.error(String(err?.message || err))
  process.exit(1)
})
`

  let byteCount = 0
  try {
    const out = runNodeScript(script, [pdfUrl, targetPath]).trim()
    byteCount = Number(out) || fs.statSync(targetPath).size
  } catch (e: any) {
    const stderr = String(e?.stderr || e?.message || e)
    return `Error: failed to download arXiv PDF. ${stderr.trim()}`
  }

  return `Downloaded arXiv PDF ${normalizedId} to ${path.relative(workspace, targetPath) || targetPath} (${byteCount} bytes)`
}

function editFile(filePath: string, oldStr: string, newStr: string, workspace: string): string {
  const p = resolvePath(filePath, workspace)
  assertInWorkspace(p, workspace)
  if (!fs.existsSync(p)) return `File not found: ${filePath}`

  const content = fs.readFileSync(p, 'utf-8')
  const count = content.split(oldStr).length - 1

  if (count === 0) {
    return `Error: old_string not found in ${filePath}. Make sure you copied the exact text including whitespace.`
  }
  if (count > 1) {
    return `Error: old_string found ${count} times in ${filePath}. It must be unique — include more surrounding context.`
  }

  const newContent = content.replace(oldStr, newStr)
  fs.writeFileSync(p, newContent)

  const oldLines = oldStr.split('\n').length
  const newLines = newStr.split('\n').length
  return `Edited ${filePath}: replaced ${oldLines} lines with ${newLines} lines`
}

function appendFile(filePath: string, content: string, workspace: string): string {
  const p = resolvePath(filePath, workspace)
  assertInWorkspace(p, workspace)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const existed = fs.existsSync(p)
  fs.appendFileSync(p, content)
  const totalContent = fs.readFileSync(p, 'utf-8')
  const totalLines = totalContent.split('\n').length
  const appendedLines = content.split('\n').length
  return existed
    ? `Appended to ${filePath}: +${appendedLines} lines (total: ${totalLines} lines, ${totalContent.length} bytes)`
    : `Created ${filePath} with ${appendedLines} lines (${content.length} bytes)`
}

function listDir(dirPath: string | undefined, workspace: string, maxDepth: number): string {
  const p = resolvePath(dirPath, workspace)
  assertInWorkspace(p, workspace)
  if (!fs.existsSync(p)) return `Not found: ${dirPath ?? '.'}`

  const lines: string[] = []
  const relRoot = path.relative(workspace, p) || '.'
  lines.push(`${relRoot}/`)

  function walk(dir: string, prefix: string, depth: number) {
    if (depth > maxDepth) {
      lines.push(`${prefix}└── …`)
      return
    }
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries = entries
      .filter((e) => !e.name.startsWith('.') && !IGNORED_DIRS.has(e.name))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
        return a.name.localeCompare(b.name)
      })

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      const isLast = i === entries.length - 1
      const connector = isLast ? '└── ' : '├── '
      const childPrefix = isLast ? '    ' : '│   '

      if (entry.isDirectory()) {
        lines.push(`${prefix}${connector}${entry.name}/`)
        walk(path.join(dir, entry.name), prefix + childPrefix, depth + 1)
      } else {
        lines.push(`${prefix}${connector}${entry.name}`)
      }
    }
  }

  walk(p, '', 1)
  let result = lines.join('\n')
  if (result.length > 50000) result = result.slice(0, 50000) + '\n… [truncated]'
  return result
}

function findFiles(pattern: string, type: string, searchPath: string | undefined, workspace: string): string {
  const p = searchPath ? resolvePath(searchPath, workspace) : workspace
  assertInWorkspace(p, workspace)

  if (type === 'content') {
    try {
      const out = execSync(
        `rg --max-count=100 --line-number --no-heading --color=never -e ${JSON.stringify(pattern)} ${JSON.stringify(p)}`,
        { timeout: 30000, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 5 },
      )
      if (!out.trim()) return `No matches for '${pattern}'`
      const result = out.length > 50000 ? out.slice(0, 50000) + '\n… [truncated]' : out
      const matchCount = result.split('\n').filter(Boolean).length
      return `Found ${matchCount} matches for '${pattern}':\n${result}`
    } catch {
      return `No matches for '${pattern}'`
    }
  }

  // type === 'name': use find with glob
  try {
    const cmd = process.platform === 'win32'
      ? `dir /s /b "${p}\\${pattern}" 2>nul`
      : `find ${JSON.stringify(p)} -name ${JSON.stringify(pattern)} -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/__pycache__/*" 2>/dev/null | head -200`
    const out = execSync(cmd, { timeout: 15000, encoding: 'utf-8', maxBuffer: 1024 * 1024 })
    if (!out.trim()) return `No files matching '${pattern}'`
    const files = out.trim().split('\n').map((f) => path.relative(workspace, f))
    return `Found ${files.length} file(s) matching '${pattern}':\n${files.join('\n')}`
  } catch {
    return `No files matching '${pattern}'`
  }
}

const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\//, // rm -rf /
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev/,
  />\s*\/dev\/sd/,
  /\bchmod\s+777\s+\//,
  /\bchown\s+.*\s+\//,
  /\bcurl\b.*\|\s*(ba)?sh/,
  /\bwget\b.*\|\s*(ba)?sh/,
]

function execCommand(command: string, cwd: string | undefined, workspace: string): string {
  const workDir = cwd ? resolvePath(cwd, workspace) : workspace
  assertInWorkspace(workDir, workspace)

  // Intercept cat/head/tail — redirect to read_file for efficiency
  const catMatch = command.match(/^\s*cat\s+(.+?)\s*$/)
  if (catMatch) {
    const filePath = catMatch[1].replace(/^['"]|['"]$/g, '')
    return `[Hint: use read_file tool instead of cat for better context efficiency]\n` + readFile(filePath, workspace)
  }

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return `Error: command blocked — matches dangerous pattern. Command: ${command}`
    }
  }

  try {
    const isWin = process.platform === 'win32'
    const out = execSync(command, {
      cwd: workDir,
      timeout: 120000,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024 * 10,
      env: { ...process.env, FORCE_COLOR: '0' },
      shell: isWin ? 'cmd.exe' : '/bin/sh',
    })
    let result = out
    if (result.length > 80000) result = result.slice(0, 80000) + '\n… [truncated]'
    return `Exit code: 0\n${result}`
  } catch (e: any) {
    const out = ((e.stdout ?? '') + '\n' + (e.stderr ?? '')).trim()
    const result = out.length > 80000 ? out.slice(0, 80000) + '\n… [truncated]' : out
    return `Exit code: ${e.status ?? -1}\n${result}`
  }
}

function createDir(dirPath: string, workspace: string): string {
  const p = resolvePath(dirPath, workspace)
  assertInWorkspace(p, workspace)
  fs.mkdirSync(p, { recursive: true })
  return `Created directory: ${dirPath}`
}

function deleteFile(filePath: string, workspace: string): string {
  const p = resolvePath(filePath, workspace)
  assertInWorkspace(p, workspace)
  if (!fs.existsSync(p)) return `File not found: ${filePath}`
  const stat = fs.statSync(p)
  if (stat.isDirectory()) return `Error: ${filePath} is a directory. Use execute_command with "rm -r" instead.`
  fs.unlinkSync(p)
  return `Deleted: ${filePath}`
}

export function executeCustomTool(
  tool: CustomTool, args: Record<string, any>, workspace: string,
): string {
  if (!workspace) return 'Error: workspace not set.'
  try {
    let cmd = tool.command
    for (const [key, val] of Object.entries(args)) {
      cmd = cmd.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(val))
    }

    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(cmd)) {
        return `Error: command blocked — matches dangerous pattern. Command: ${cmd}`
      }
    }

    const out = execSync(cmd, {
      cwd: workspace,
      timeout: 120000,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024 * 10,
      env: { ...process.env, FORCE_COLOR: '0', ...Object.fromEntries(
        Object.entries(args).map(([k, v]) => [`TOOL_${k.toUpperCase()}`, String(v)]),
      )},
    })
    let result = out
    if (result.length > 80000) result = result.slice(0, 80000) + '\n… [truncated]'
    return `Exit code: 0\n${result}`
  } catch (e: any) {
    const out = ((e.stdout ?? '') + '\n' + (e.stderr ?? '')).trim()
    const result = out.length > 80000 ? out.slice(0, 80000) + '\n… [truncated]' : out
    return `Exit code: ${e.status ?? -1}\n${result}`
  }
}
