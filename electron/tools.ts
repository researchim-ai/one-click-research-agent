import { execFileSync, execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import type { CustomTool } from './config'

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
        return searchArxiv(args.query, args.max_results)
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

function searchArxiv(query: string, maxResults?: number): string {
  const trimmedQuery = String(query ?? '').trim()
  if (!trimmedQuery) return 'Error: query is required.'

  const limit = Math.max(1, Math.min(10, Number(maxResults) || 5))
  const script = `
const query = process.argv[1]
const limit = Number(process.argv[2] || '5')
const url = 'http://export.arxiv.org/api/query?search_query=' + encodeURIComponent('all:' + query) + '&start=0&max_results=' + limit
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
    xml = runNodeScript(script, [trimmedQuery, String(limit)])
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

  return `Found ${entries.length} arXiv paper(s) for "${trimmedQuery}":\n\n${lines.join('\n\n')}`
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
