import { memo, useMemo, useState } from 'react'
import Markdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import type { OpenFile } from '../hooks/useEditor'
import { CodeEditor, type CodeSelectionInfo } from './CodeEditor'

const rehypePlugins = [rehypeHighlight] as any[]

interface Props {
  file: OpenFile
  workspace?: string
  onAttachCode?: (info: CodeSelectionInfo) => void
  onOpenFile?: (path: string) => void
  onContentChange?: (content: string) => void
  onAfterSave?: () => void
  onBreadcrumbClick?: (dirPath: string) => void
  appLanguage?: 'ru' | 'en'
}

function relPath(workspace: string | undefined, filePath: string): string {
  if (workspace && filePath.startsWith(workspace)) {
    return filePath.slice(workspace.length).replace(/^[\\/]/, '') || filePath
  }
  return filePath
}

export const MarkdownViewer = memo(function MarkdownViewer({
  file,
  workspace,
  onAttachCode,
  onOpenFile,
  onContentChange,
  onAfterSave,
  onBreadcrumbClick,
  appLanguage = 'ru',
}: Props) {
  const L = appLanguage === 'ru'
  const [mode, setMode] = useState<'preview' | 'edit'>('preview')
  const title = useMemo(() => relPath(workspace, file.path), [workspace, file.path])

  if (mode === 'edit') {
    return (
      <div className="flex flex-col min-h-0 flex-1">
        <div className="flex items-center justify-between gap-2 px-4 py-2 bg-[#0d1117] border-b border-zinc-800/60">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wider text-zinc-500">Markdown</div>
            <div className="text-[12px] text-zinc-300 font-mono truncate">{title}</div>
          </div>
          <button
            onClick={() => setMode('preview')}
            className="px-2.5 py-1 rounded-md bg-blue-500/15 text-blue-300 hover:bg-blue-500/25 text-[11px] font-medium cursor-pointer"
          >
            Preview
          </button>
        </div>
        <CodeEditor
          file={file}
          workspace={workspace}
          onAttachCode={onAttachCode}
          onOpenFile={onOpenFile}
          onContentChange={onContentChange}
          onAfterSave={onAfterSave}
          onBreadcrumbClick={onBreadcrumbClick}
          appLanguage={appLanguage}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col min-h-0 flex-1 bg-[#0d1117]">
      <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-zinc-800/60 shrink-0">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wider text-zinc-500">Markdown preview</div>
          <div className="text-[12px] text-zinc-300 font-mono truncate">{title}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] text-zinc-500 font-mono">
            {file.lines} {L ? 'строк' : 'lines'}
          </span>
          <button
            onClick={() => setMode('edit')}
            className="px-2.5 py-1 rounded-md bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 text-[11px] font-medium cursor-pointer"
          >
            {L ? 'Редактировать' : 'Edit'}
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-6">
        <article className="markdown-preview mx-auto max-w-[920px] rounded-2xl border border-zinc-800/70 bg-zinc-950/45 px-8 py-7 shadow-2xl shadow-black/20">
          <Markdown rehypePlugins={rehypePlugins}>{file.content}</Markdown>
        </article>
      </div>
    </div>
  )
})
