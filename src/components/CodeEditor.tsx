import { useCallback, useEffect, useRef, useState, memo, type MouseEvent } from 'react'
import Editor from '@monaco-editor/react'
import type { editor, IRange } from 'monaco-editor'
import type { OpenFile } from '../hooks/useEditor'
import { ContextMenu, type MenuItem } from './ContextMenu'

export interface CodeSelectionInfo {
  filePath: string
  relativePath: string
  startLine: number
  endLine: number
  content: string
  language: string
}

/** Resolve relative path against the directory of basePath (file path). */
function resolveRelative(baseFilePath: string, relativePath: string): string {
  const sep = baseFilePath.includes('\\') ? '\\' : '/'
  const dir = baseFilePath.replace(/[/\\][^/\\]+$/, '')
  const parts: string[] = (dir + sep + relativePath).split(/[/\\]/).filter(Boolean)
  const out: string[] = []
  for (const p of parts) {
    if (p === '..') out.pop()
    else if (p !== '.') out.push(p)
  }
  return out.join(sep) || sep
}

/** Find import/require path ranges in source. Returns { line, startCol, endCol, path } (1-based line). */
function findImportPaths(content: string): { line: number; startCol: number; endCol: number; path: string }[] {
  const lines = content.split('\n')
  const result: { line: number; startCol: number; endCol: number; path: string }[] = []
  const reSingle = /(?:import\s+.*\s+from\s*|import\s*|require\s*\()\s*['"]([^'"]+)['"]/g
  const reDynamic = /(?:import\s*\(\s*|require\s*\()\s*['"]([^'"]+)['"]/g
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const re of [reSingle, reDynamic]) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(line)) !== null) {
        const path = m[1]
        if (path.startsWith('.') || path.startsWith('/')) {
          result.push({
            line: i + 1,
            startCol: m.index + (m[0].indexOf(m[1])),
            endCol: m.index + (m[0].indexOf(m[1]) + m[1].length),
            path,
          })
        }
      }
    }
  }
  return result
}

const MONACO_LANG: Record<string, string> = {
  plaintext: 'plaintext',
  typescript: 'typescript',
  javascript: 'javascript',
  json: 'json',
  html: 'html',
  xml: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  markdown: 'markdown',
  python: 'python',
  rust: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  csharp: 'csharp',
  php: 'php',
  ruby: 'ruby',
  yaml: 'yaml',
  ini: 'ini',
  sql: 'sql',
  bash: 'shell',
  powershell: 'powershell',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const TS_JS_LANGS = ['typescript', 'javascript']
const PYTHON_LANG = 'python'
const DIAGNOSTICS_DEBOUNCE_MS = 400

/** Get Python module name under cursor for "import X" / "from X import Y" lines. Returns null if not on an import. */
function getPythonModuleAtLine(line: string, column: number): string | null {
  const col0 = column - 1
  if (col0 < 0) return null
  const mImport = line.match(/^\s*import\s+([a-zA-Z_][a-zA-Z0-9_.]*)/)
  if (mImport) {
    const full = mImport[1]
    const start = line.indexOf(full)
    if (col0 >= start && col0 < start + full.length) return full
    return null
  }
  const mFrom = line.match(/^\s*from\s+([a-zA-Z_][a-zA-Z0-9_.]*)\s+import\s+([a-zA-Z_][a-zA-Z0-9_.*]+)/)
  if (mFrom) {
    const [, fromMod, importPart] = mFrom
    const fromStart = line.indexOf(fromMod)
    if (col0 >= fromStart && col0 < fromStart + fromMod.length) return fromMod
    const firstImport = importPart.split(',')[0].trim().split(/\s+as\s+/)[0].trim()
    const impStart = line.indexOf(firstImport)
    if (impStart >= 0 && col0 >= impStart && col0 < impStart + firstImport.length) {
      if (firstImport.includes('*')) return fromMod
      return `${fromMod}.${firstImport}`
    }
  }
  return null
}

interface Props {
  file: OpenFile
  workspace?: string
  onAttachCode?: (info: CodeSelectionInfo) => void
  onOpenFile?: (path: string) => void
  onContentChange?: (content: string) => void
  onAfterSave?: () => void
  /** Called when user clicks a directory segment in the path breadcrumb (to expand that dir in the sidebar). */
  onBreadcrumbClick?: (dirPath: string) => void
}

export const CodeEditor = memo(function CodeEditor({ file, workspace, onAttachCode, onOpenFile, onContentChange, onAfterSave, onBreadcrumbClick }: Props) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof import('monaco-editor') | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const linkProviderDisposable = useRef<{ dispose(): void } | null>(null)
  const tsProvidersDisposable = useRef<{ dispose(): void } | null>(null)
  const linksByLineRef = useRef<Map<number, { startCol: number; endCol: number; resolvedPath: string }[]>>(new Map())

  const relPath = useCallback(
    (fullPath: string) => {
      if (workspace && fullPath.startsWith(workspace)) {
        return fullPath.slice(workspace.length).replace(/^[\\/]/, '') || fullPath
      }
      return fullPath
    },
    [workspace]
  )

  const importLinks = useRef<{ line: number; startCol: number; endCol: number; resolvedPath: string }[]>([])
  importLinks.current = (() => {
    const raw = findImportPaths(file.content)
    const out: { line: number; startCol: number; endCol: number; resolvedPath: string }[] = []
    for (const r of raw) {
      const resolved = resolveRelative(file.path, r.path)
      out.push({ line: r.line, startCol: r.startCol, endCol: r.endCol, resolvedPath: resolved })
    }
    return out
  })()

  useEffect(() => {
    const byLine = new Map<number, { startCol: number; endCol: number; resolvedPath: string }[]>()
    for (const l of importLinks.current) {
      const list = byLine.get(l.line) ?? []
      list.push({ startCol: l.startCol, endCol: l.endCol, resolvedPath: l.resolvedPath })
      byLine.set(l.line, list)
    }
    linksByLineRef.current = byLine
  }, [file.path, file.content])

  const handleEditorMount = useCallback(
    (editor: editor.IStandaloneCodeEditor, monaco: typeof import('monaco-editor')) => {
      editorRef.current = editor
      monacoRef.current = monaco
      if (typeof document !== 'undefined') document.body.classList.add('monaco-editor')

      monaco.editor.setTheme('app-dark')

      if (linkProviderDisposable.current) {
        linkProviderDisposable.current.dispose()
        linkProviderDisposable.current = null
      }
      if (tsProvidersDisposable.current) {
        tsProvidersDisposable.current.dispose()
        tsProvidersDisposable.current = null
      }

      const selector = [
        { language: 'typescript' }, { language: 'javascript' }, { language: 'json' }, { language: 'plaintext' },
        { language: 'python' }, { language: 'rust' }, { language: 'go' }, { language: 'html' }, { language: 'css' },
      ]
      const linkProvider = monaco.languages.registerLinkProvider(selector, {
        provideLinks: () => {
          const links: { range: IRange; url?: string; tooltip?: string }[] = []
          for (const { line, startCol, endCol, resolvedPath } of importLinks.current) {
            links.push({
              range: { startLineNumber: line, startColumn: startCol, endLineNumber: line, endColumn: endCol },
              url: `workspace-file:${resolvedPath}`,
              tooltip: resolvedPath,
            })
          }
          return { links }
        },
      })
      linkProviderDisposable.current = linkProvider

      const disposables: { dispose(): void }[] = []
      if (workspace && window.api && TS_JS_LANGS.includes(file.language)) {
        disposables.push(monaco.languages.registerDefinitionProvider(
          [{ language: 'typescript' }, { language: 'javascript' }],
          {
            provideDefinition: async (model, position) => {
              const content = model.getValue()
              const def = await window.api!.tsGetDefinition(workspace, file.path, content, position.lineNumber, position.column)
              if (!def) return null
              return { uri: monaco.Uri.file(def.path), range: { startLineNumber: def.startLine, startColumn: def.startColumn, endLineNumber: def.endLine, endColumn: def.endColumn } }
            },
          }
        ))
        disposables.push(monaco.languages.registerHoverProvider(
          [{ language: 'typescript' }, { language: 'javascript' }],
          {
            provideHover: async (model, position) => {
              const content = model.getValue()
              const hover = await window.api!.tsGetHover(workspace, file.path, content, position.lineNumber, position.column)
              if (!hover) return null
              return { contents: [{ value: hover.contents }] }
            },
          }
        ))
        disposables.push(monaco.languages.registerCompletionItemProvider(
          [{ language: 'typescript' }, { language: 'javascript' }],
          {
            triggerCharacters: ['.', '"', "'", '/', '@', '<'],
            provideCompletionItems: async (model, position) => {
              const content = model.getValue()
              const items = await window.api!.tsGetCompletions(workspace, file.path, content, position.lineNumber, position.column)
              const range = { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column }
              return {
                suggestions: items.map((item) => ({
                  label: item.label,
                  kind: item.kind as number,
                  insertText: item.insertText ?? item.label,
                  detail: item.detail,
                  range,
                })),
              }
            },
          }
        ))
      }
      if (workspace && window.api && onOpenFile && file.language === PYTHON_LANG) {
        disposables.push(monaco.languages.registerDefinitionProvider(
          [{ language: 'python' }],
          {
            provideDefinition: async (model, position) => {
              const line = model.getLineContent(position.lineNumber)
              const moduleName = getPythonModuleAtLine(line, position.column)
              if (!moduleName) return null
              const filePath = await window.api!.pyResolveModule(workspace, moduleName)
              if (!filePath) return null
              onOpenFile(filePath)
              return {
                uri: monaco.Uri.file(filePath),
                range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
              }
            },
          }
        ))
      }
      tsProvidersDisposable.current = { dispose: () => disposables.forEach((d) => d.dispose()) }

      editor.addAction({
        id: 'editor.save-file',
        label: 'Сохранить файл',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run: async () => {
          const content = editor.getModel()?.getValue() ?? ''
          try {
            await window.api?.writeFile(file.path, content)
            onAfterSave?.()
          } catch (e) {
            console.error('Save failed:', e)
          }
        },
      })

      editor.onMouseDown((e) => {
        const isMod = e.event.ctrlKey || e.event.metaKey
        if (!isMod) return
        const target = e.target
        if (!target?.position) return
        const { lineNumber, column } = target.position
        const lineLinks = linksByLineRef.current.get(lineNumber) ?? []
        for (const { startCol, endCol, resolvedPath } of lineLinks) {
          if (column >= startCol && column <= endCol) {
            e.event.preventDefault()
            e.event.stopPropagation()
            if (onOpenFile) onOpenFile(resolvedPath)
            return
          }
        }
        if (TS_JS_LANGS.includes(file.language)) {
          e.event.preventDefault()
          setTimeout(() => editor.trigger('ctrlclick', 'editor.action.showHover', {}), 0)
        }
        if (file.language === PYTHON_LANG) {
          e.event.preventDefault()
          setTimeout(() => editor.trigger('ctrlclick', 'editor.action.revealDefinition', {}), 0)
        }
      })
    },
    [file.path, file.language, onOpenFile, onAfterSave, workspace]
  )

  useEffect(() => {
    return () => {
      linkProviderDisposable.current?.dispose()
      linkProviderDisposable.current = null
      tsProvidersDisposable.current?.dispose()
      tsProvidersDisposable.current = null
      if (typeof document !== 'undefined') document.body.classList.remove('monaco-editor')
    }
  }, [])

  // Prevent peek widget (References) and hover inner content from collapsing (re-apply min dimensions).
  useEffect(() => {
    if (typeof document === 'undefined') return

    const forceMinSize = (el: HTMLElement, minW: string, minH: string) => {
      if (!el.style) return
      el.style.setProperty('min-width', minW, 'important')
      el.style.setProperty('min-height', minH, 'important')
      const w = el.style.getPropertyValue('width')
      const h = el.style.getPropertyValue('height')
      if (w === '0px' || w === '0') el.style.setProperty('width', 'auto', 'important')
      if (h === '0px' || h === '0') el.style.setProperty('height', 'auto', 'important')
    }

    const forcePeekPreviewEditorSize = (peekEl: Element) => {
      const preview = peekEl.querySelector('.preview.inline')
      if (!preview) return
      const editor = preview.querySelector('.monaco-editor') as HTMLElement | null
      const guard = preview.querySelector('.overflow-guard') as HTMLElement | null
      for (const el of [editor, guard]) {
        if (!el?.style) continue
        const w = el.style.getPropertyValue('width')
        const h = el.style.getPropertyValue('height')
        if (w === '5px' || w === '0px' || w === '0' || parseFloat(w) < 10) el.style.setProperty('width', '100%', 'important')
        if (h === '5px' || h === '0px' || h === '0' || parseFloat(h) < 10) el.style.setProperty('height', '100%', 'important')
      }
    }

    const processWidget = (el: Element) => {
      const html = el as HTMLElement
      forceMinSize(html, '320px', '40px')
      const body = el.querySelector('.body') as HTMLElement | null
      if (body) {
        forceMinSize(body, '300px', '60px')
        body.querySelectorAll(':scope > *').forEach((child) => {
          forceMinSize(child as HTMLElement, '260px', '24px')
        })
      }
      el.querySelectorAll('.monaco-list, .monaco-scrollable-element').forEach((child) => {
        forceMinSize(child as HTMLElement, '280px', '60px')
      })
      forcePeekPreviewEditorSize(el)
    }

    const run = () => {
      document.body.querySelectorAll('[class*="peekview"], [class*="peek-view"], .monaco-hover').forEach(processWidget)
    }

    const observer = new MutationObserver(() => {
      run()
      requestAnimationFrame(run)
    })
    observer.observe(document.body, { childList: true, subtree: true })

    const interval = setInterval(run, 120)
    return () => {
      observer.disconnect()
      clearInterval(interval)
    }
  }, [])

  const diagnosticsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!workspace || !TS_JS_LANGS.includes(file.language) || !window.api?.tsGetDiagnostics) return
    const run = () => {
      window.api!.tsGetDiagnostics(workspace!, file.path, file.content).then((list) => {
        const monaco = monacoRef.current
        const model = editorRef.current?.getModel()
        if (!monaco || !model) return
        const markers = list.map((d) => ({
          severity: d.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
          message: d.message,
          startLineNumber: d.line,
          startColumn: d.column,
          endLineNumber: d.line,
          endColumn: d.column + 1,
        }))
        monaco.editor.setModelMarkers(model, 'ts', markers)
      }).catch(() => {})
    }
    if (diagnosticsTimerRef.current) clearTimeout(diagnosticsTimerRef.current)
    diagnosticsTimerRef.current = setTimeout(run, DIAGNOSTICS_DEBOUNCE_MS)
    return () => {
      if (diagnosticsTimerRef.current) clearTimeout(diagnosticsTimerRef.current)
      const model = editorRef.current?.getModel()
      if (model && monacoRef.current) monacoRef.current.editor.setModelMarkers(model, 'ts', [])
    }
  }, [file.path, file.content, file.language, workspace])

  const handleContextMenu = useCallback((e: MouseEvent) => {
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY })
  }, [])

  const getSelection = useCallback((): string => {
    const ed = editorRef.current
    if (!ed) return ''
    const sel = ed.getSelection()
    if (!sel) return ''
    return ed.getModel()?.getValueInRange(sel) ?? ''
  }, [])

  const getSelectionRange = useCallback((): { startLine: number; endLine: number } | null => {
    const ed = editorRef.current
    const sel = ed?.getSelection()
    if (!sel) return null
    return {
      startLine: sel.startLineNumber,
      endLine: sel.endLineNumber,
    }
  }, [])

  const lines = file.content.split('\n')
  const buildMenu = useCallback((): MenuItem[] => {
    const sel = getSelection()
    const items: MenuItem[] = []

    if (sel) {
      items.push({
        label: 'Копировать',
        icon: '📋',
        shortcut: 'Ctrl+C',
        action: () => window.api?.copyToClipboard(sel),
      })
      if (onAttachCode) {
        const range = getSelectionRange()
        if (range) {
          const selectedLines = lines.slice(range.startLine - 1, range.endLine).join('\n')
          items.push({
            label: `Прикрепить к чату (L${range.startLine}–${range.endLine})`,
            icon: '💬',
            action: () => {
              onAttachCode({
                filePath: file.path,
                relativePath: relPath(file.path),
                startLine: range.startLine,
                endLine: range.endLine,
                content: selectedLines,
                language: file.language,
              })
            },
          })
        }
      }
      items.push({ label: '', separator: true, action: () => {} })
    }

    items.push({
      label: 'Найти (Ctrl+F)',
      icon: '🔎',
      shortcut: 'Ctrl+F',
      action: () => editorRef.current?.trigger('keyboard', 'editor.action.startFindAction', {}),
    })
    if (onAfterSave) {
      items.push({
        label: 'Сохранить (Ctrl+S)',
        icon: '💾',
        shortcut: 'Ctrl+S',
        action: () => editorRef.current?.getModel() && window.api?.writeFile(file.path, editorRef.current!.getModel()!.getValue()).then(onAfterSave),
      })
    }
    items.push({ label: '', separator: true, action: () => {} })
    items.push({
      label: 'Выделить всё',
      icon: '▣',
      shortcut: 'Ctrl+A',
      action: () => editorRef.current?.trigger('keyboard', 'editor.action.selectAll', {}),
    })
    items.push({ label: '', separator: true, action: () => {} })
    items.push({
      label: 'Копировать путь к файлу',
      icon: '📋',
      action: () => window.api?.copyToClipboard(file.path),
    })
    items.push({
      label: 'Копировать относительный путь',
      icon: '📋',
      action: () => window.api?.copyToClipboard(relPath(file.path)),
    })
    items.push({
      label: 'Показать в проводнике',
      icon: '📂',
      action: () => window.api?.revealInExplorer(file.path),
    })
    return items
  }, [file, getSelection, getSelectionRange, lines, onAttachCode, onAfterSave, relPath])

  const monacoLang = MONACO_LANG[file.language] ?? file.language ?? 'plaintext'

  const pathSep = file.path.includes('\\') ? '\\' : '/'
  const pathParts = file.path.split(pathSep)
  const pathUpTo = (idx: number): string => {
    if (pathParts[0] === '') return pathSep + pathParts.slice(1, idx + 1).join(pathSep)
    return pathParts.slice(0, idx + 1).join(pathSep)
  }

  return (
    <div className="flex flex-col h-full bg-[#0d1117]">
      <div className="flex items-center gap-1.5 px-4 py-1.5 bg-[#0d1117] border-b border-zinc-800/60 text-[11px] text-zinc-500 font-mono shrink-0 min-w-0">
        {pathParts.map((part, i, arr) => (
          <span key={i} className="flex items-center gap-1.5 shrink-0">
            {i > 0 && <span className="text-zinc-600">{pathSep}</span>}
            {onBreadcrumbClick && i < arr.length - 1 ? (
              <button
                type="button"
                className="text-zinc-400 hover:text-blue-400 hover:underline truncate max-w-[120px] cursor-pointer"
                title={pathUpTo(i)}
                onClick={() => onBreadcrumbClick(pathUpTo(i))}
              >
                {part || (pathSep === '/' ? '/' : '')}
              </button>
            ) : (
              <span className={i === arr.length - 1 ? 'text-zinc-300' : 'text-zinc-500'}>{part || (pathSep === '/' ? '/' : '')}</span>
            )}
          </span>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-hidden" onContextMenu={handleContextMenu}>
        <Editor
          height="100%"
          language={monacoLang}
          value={file.content}
          theme="app-dark"
          path={file.path}
          beforeMount={(monaco) => {
            monaco.editor.defineTheme('app-dark', {
              base: 'vs-dark',
              inherit: true,
              rules: [],
              colors: {
                'editor.background': '#0d1117',
                'editor.foreground': '#c9d1d9',
              },
            })
          }}
          onMount={handleEditorMount}
          onChange={(value) => onContentChange?.(value ?? '')}
          options={{
            readOnly: !onContentChange,
            minimap: { enabled: true },
            contextmenu: false,
            fontSize: 13,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            wordWrap: 'off',
            renderLineHighlight: 'line',
            folding: true,
            links: true,
            padding: { top: 8, bottom: 8 },
            scrollbar: {
              verticalScrollbarSize: 10,
              horizontalScrollbarSize: 10,
            },
            fixedOverflowWidgets: true,
            overflowWidgetsDomNode: typeof document !== 'undefined' ? document.body : undefined,
          }}
          loading={<div className="flex items-center justify-center h-full bg-[#0d1117] text-zinc-500">Загрузка редактора…</div>}
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 px-4 py-1 bg-[#0d1117] border-t border-zinc-800/60 text-[11px] text-zinc-500 font-mono shrink-0">
        <span>{file.language}</span>
        <span>{file.lines} lines</span>
        <span>{formatSize(file.size)}</span>
        {onOpenFile && <span className="text-zinc-600 text-[10px]">Ctrl+Click по импорту — открыть файл</span>}
        {TS_JS_LANGS.includes(file.language) && <span className="text-zinc-600 text-[10px]">Ctrl+Click — подсказка</span>}
        {file.language === PYTHON_LANG && <span className="text-zinc-600 text-[10px]">Ctrl+Click по импорту — в определение</span>}
        {onAfterSave && <span className="text-zinc-600 text-[10px]">Ctrl+S — сохранить</span>}
        <span className="ml-auto">UTF-8</span>
      </div>

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={buildMenu()}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  )
})
