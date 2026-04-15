import { useMemo } from 'react'
import { DiffEditor } from '@monaco-editor/react'

const MONACO_LANG: Record<string, string> = {
  plaintext: 'plaintext',
  typescript: 'typescript',
  javascript: 'javascript',
  json: 'json',
  html: 'html',
  css: 'css',
  scss: 'scss',
  python: 'python',
  rust: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  csharp: 'csharp',
  markdown: 'markdown',
  yaml: 'yaml',
  sql: 'sql',
  bash: 'shell',
  dockerfile: 'dockerfile',
}

interface Props {
  filePath: string
  original: string
  modified: string
  onClose: () => void
  appLanguage?: 'ru' | 'en'
}

export function DiffViewer({ filePath, original, modified, onClose, appLanguage = 'ru' }: Props) {
  const language = useMemo(() => {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
    return MONACO_LANG[ext] ?? ext ?? 'plaintext'
  }, [filePath])

  const fileName = filePath.replace(/^.*[/\\]/, '')

  return (
    <div className="flex flex-col h-full bg-[#0d1117]">
      <div className="flex items-center justify-between gap-2 px-4 py-1.5 bg-[#0d1117] border-b border-zinc-800/60 text-[11px] text-zinc-500 font-mono shrink-0">
        <span className="truncate text-zinc-400" title={filePath}>
          Diff: {fileName}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 px-2 py-0.5 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200"
        >
          {appLanguage === 'ru' ? 'Закрыть' : 'Close'}
        </button>
      </div>
      <div className="flex-1 min-h-0">
        <DiffEditor
          original={original}
          modified={modified}
          language={language}
          theme="vs-dark"
          options={{
            readOnly: true,
            renderSideBySide: true,
            enableSplitViewResizing: true,
            fontSize: 13,
            minimap: { enabled: true },
          }}
          height="100%"
        />
      </div>
    </div>
  )
}
