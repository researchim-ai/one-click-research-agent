/**
 * TypeScript language service for the editor: definition, hover, completions, diagnostics.
 * Runs in the main process; renderer calls via IPC.
 */
import * as fs from 'fs'
import * as path from 'path'
import * as ts from 'typescript'

const SCRIPT_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__'])

function collectScriptFiles(dir: string, out: string[] = []): string[] {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) collectScriptFiles(full, out)
      } else if (SCRIPT_EXT.has(path.extname(e.name).toLowerCase())) {
        out.push(path.normalize(full))
      }
    }
  } catch (_) {}
  return out
}

function lineColumnToOffset(content: string, line: number, column: number): number {
  const lines = content.split(/\r?\n/)
  let offset = 0
  for (let i = 0; i < line - 1 && i < lines.length; i++) offset += lines[i].length + 1
  offset += Math.min(column - 1, lines[line - 1]?.length ?? 0)
  return offset
}

function offsetToLineColumn(content: string, offset: number): { line: number; column: number } {
  const lines = content.split(/\r?\n/)
  let left = offset
  for (let i = 0; i < lines.length; i++) {
    const lineLen = lines[i].length + 1
    if (left < lineLen) return { line: i + 1, column: left + 1 }
    left -= lineLen
  }
  return { line: lines.length, column: 1 }
}

let defaultLibContent: string | null = null
function getDefaultLibContent(): string {
  if (defaultLibContent) return defaultLibContent
  try {
    const tsPath = require.resolve('typescript')
    const libPath = path.join(path.dirname(tsPath), 'lib.d.ts')
    defaultLibContent = fs.readFileSync(libPath, 'utf-8')
  } catch {
    defaultLibContent = '/* default lib */'
  }
  return defaultLibContent
}

export interface TsServiceHost {
  workspacePath: string
  fileOverrides: Map<string, string>
  scriptFiles: string[]
  getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined
}

export function createTsHost(workspacePath: string): TsServiceHost {
  const root = path.normalize(workspacePath)
  const scriptFiles = collectScriptFiles(root)
  const fileOverrides = new Map<string, string>()

  const host: TsServiceHost = {
    workspacePath: root,
    fileOverrides,
    scriptFiles,
    getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
      const normalized = path.normalize(fileName)
      if (fileOverrides.has(normalized)) {
        return ts.ScriptSnapshot.fromString(fileOverrides.get(normalized)!)
      }
      if (fileName.includes('lib.') && fileName.endsWith('.d.ts')) {
        return ts.ScriptSnapshot.fromString(getDefaultLibContent())
      }
      try {
        if (fs.existsSync(normalized)) {
          return ts.ScriptSnapshot.fromString(fs.readFileSync(normalized, 'utf-8'))
        }
      } catch (_) {}
      return undefined
    },
  }
  return host
}

export function createLanguageService(host: TsServiceHost): ts.LanguageService {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowJs: true,
    checkJs: false,
    noEmit: true,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    skipLibCheck: true,
    strict: false,
    jsx: ts.JsxEmit.React,
  }

  const lsHost: ts.LanguageServiceHost = {
    getScriptFileNames: () => Array.from(new Set([...host.scriptFiles, ...host.fileOverrides.keys()])),
    getScriptVersion: () => '0',
    getScriptSnapshot: (fileName) => host.getScriptSnapshot(fileName),
    getCurrentDirectory: () => host.workspacePath,
    getCompilationSettings: () => compilerOptions,
    getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
    readFile: (fileName) => {
      const snap = host.getScriptSnapshot(fileName)
      return snap?.getText(0, snap.getLength())
    },
    fileExists: (fileName) => {
      if (host.fileOverrides.has(path.normalize(fileName))) return true
      try {
        return fs.existsSync(path.normalize(fileName))
      } catch {
        return false
      }
    },
  }
  return ts.createLanguageService(lsHost, ts.createDocumentRegistry())
}

const serviceCache = new Map<string, { host: TsServiceHost; service: ts.LanguageService }>()

function getOrCreateService(workspacePath: string): { host: TsServiceHost; service: ts.LanguageService } {
  const key = path.normalize(workspacePath)
  let entry = serviceCache.get(key)
  if (!entry) {
    const host = createTsHost(workspacePath)
    const service = createLanguageService(host)
    entry = { host, service }
    serviceCache.set(key, entry)
  }
  return entry
}

export function setFileOverride(workspacePath: string, filePath: string, content: string | null): void {
  const { host } = getOrCreateService(workspacePath)
  const normalized = path.normalize(filePath)
  if (content === null) host.fileOverrides.delete(normalized)
  else host.fileOverrides.set(normalized, content)
}

export interface DefinitionLocation {
  path: string
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
}

export function getDefinition(
  workspacePath: string,
  filePath: string,
  fileContent: string,
  line: number,
  column: number
): DefinitionLocation | null {
  const { host, service } = getOrCreateService(workspacePath)
  const normalized = path.normalize(filePath)
  host.fileOverrides.set(normalized, fileContent)
  try {
    const offset = lineColumnToOffset(fileContent, line, column)
    const defs = service.getDefinitionAtPosition(normalized, offset)
    if (!defs?.length) return null
    const d = defs[0]
    if (d.fileName && d.textSpan) {
      const snapshot = host.getScriptSnapshot(d.fileName)
      const text = snapshot?.getText(0, snapshot.getLength()) ?? ''
      const start = offsetToLineColumn(text, d.textSpan.start)
      const end = offsetToLineColumn(text, d.textSpan.start + d.textSpan.length)
      return {
        path: d.fileName,
        startLine: start.line,
        startColumn: start.column,
        endLine: end.line,
        endColumn: end.column,
      }
    }
  } finally {
    host.fileOverrides.delete(normalized)
  }
  return null
}

export interface HoverResult {
  contents: string
}

export function getHover(
  workspacePath: string,
  filePath: string,
  fileContent: string,
  line: number,
  column: number
): HoverResult | null {
  const { host, service } = getOrCreateService(workspacePath)
  const normalized = path.normalize(filePath)
  host.fileOverrides.set(normalized, fileContent)
  try {
    const offset = lineColumnToOffset(fileContent, line, column)
    const info = service.getQuickInfoAtPosition(normalized, offset)
    if (!info?.displayParts?.length) return null
    const contents = info.displayParts.map((p) => p.text).join('')
    if (info.documentation?.length) {
      return { contents: contents + '\n\n' + info.documentation.map((p) => p.text).join('') }
    }
    return { contents }
  } finally {
    host.fileOverrides.delete(normalized)
  }
  return null
}

export interface CompletionItem {
  label: string
  kind: ts.ScriptElementKind
  insertText?: string
  detail?: string
}

export function getCompletions(
  workspacePath: string,
  filePath: string,
  fileContent: string,
  line: number,
  column: number
): CompletionItem[] {
  const { host, service } = getOrCreateService(workspacePath)
  const normalized = path.normalize(filePath)
  host.fileOverrides.set(normalized, fileContent)
  try {
    const offset = lineColumnToOffset(fileContent, line, column)
    const entries = service.getCompletionsAtPosition(normalized, offset, { includeCompletionsForModuleExports: true })
    if (!entries?.entries?.length) return []
    return entries.entries.map((e) => ({
      label: e.name,
      kind: e.kind,
      insertText: e.insertText,
      detail: e.kindModifiers ? `${e.kindModifiers}` : undefined,
    }))
  } finally {
    host.fileOverrides.delete(normalized)
  }
  return []
}

export interface DiagnosticItem {
  line: number
  column: number
  message: string
  severity: 'error' | 'warning'
}

export function getDiagnostics(
  workspacePath: string,
  filePath: string,
  fileContent?: string
): DiagnosticItem[] {
  const { host, service } = getOrCreateService(workspacePath)
  const normalized = path.normalize(filePath)
  if (fileContent != null) host.fileOverrides.set(normalized, fileContent)
  try {
    const diag = service.getSemanticDiagnostics(normalized)
    const out: DiagnosticItem[] = []
    const snapshot = host.getScriptSnapshot(normalized)
    const text = snapshot?.getText(0, snapshot.getLength()) ?? ''
    for (const d of diag) {
      if (d.file && d.start != null && d.length != null) {
        const start = offsetToLineColumn(text, d.start)
        out.push({
          line: start.line,
          column: start.column,
          message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
          severity: d.category === ts.DiagnosticCategory.Error ? 'error' : 'warning',
        })
      }
    }
    return out
  } finally {
    if (fileContent != null) host.fileOverrides.delete(normalized)
  }
}

export function invalidateWorkspace(workspacePath: string): void {
  serviceCache.delete(path.normalize(workspacePath))
}
