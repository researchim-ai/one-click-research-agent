import { useState } from 'react'
import type { OpenFile } from '../hooks/useEditor'

interface Props {
  file: OpenFile
  workspace?: string
  onBreadcrumbClick?: (dirPath: string) => void
  appLanguage?: 'ru' | 'en'
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const KIND_ICON: Record<string, string> = {
  image: '🖼️', pdf: '📄', video: '🎬', audio: '🎵', binary: '📦', text: '📄',
}

export function MediaViewer({ file, workspace, onBreadcrumbClick, appLanguage = 'ru' }: Props) {
  const L = appLanguage === 'ru'
  const [actualSize, setActualSize] = useState(false)
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)

  const pathSep = file.path.includes('\\') ? '\\' : '/'
  const pathParts = file.path.split(pathSep)
  const pathUpTo = (idx: number): string => {
    if (pathParts[0] === '') return pathSep + pathParts.slice(1, idx + 1).join(pathSep)
    return pathParts.slice(0, idx + 1).join(pathSep)
  }

  const hasPreview = !!file.dataUrl
  const kindLabelRu: Record<string, string> = {
    image: 'Изображение', pdf: 'PDF', video: 'Видео', audio: 'Аудио', binary: 'Бинарный файл', text: 'Текст',
  }
  const kindLabel = L ? (kindLabelRu[file.kind] ?? file.kind) : file.kind

  return (
    <div className="flex flex-col h-full bg-[#0d1117]">
      {/* Breadcrumb */}
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

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center p-4 bg-[#0b0f15]">
        {file.kind === 'image' && hasPreview && (
          <img
            src={file.dataUrl!}
            alt={file.name}
            onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            onClick={() => setActualSize((v) => !v)}
            className={actualSize ? 'cursor-zoom-out' : 'max-w-full max-h-full object-contain cursor-zoom-in'}
          />
        )}

        {file.kind === 'pdf' && hasPreview && (
          <iframe title={file.name} src={file.dataUrl!} className="w-full h-full border-0 bg-white rounded" />
        )}

        {file.kind === 'video' && hasPreview && (
          <video src={file.dataUrl!} controls className="max-w-full max-h-full rounded" />
        )}

        {file.kind === 'audio' && hasPreview && (
          <div className="flex flex-col items-center gap-4">
            <div className="text-5xl">🎵</div>
            <audio src={file.dataUrl!} controls className="w-[320px] max-w-full" />
          </div>
        )}

        {/* Binary / oversized / no preview */}
        {!hasPreview && (
          <div className="flex flex-col items-center gap-3 text-center max-w-sm">
            <div className="text-5xl">{KIND_ICON[file.kind] ?? '📦'}</div>
            <div className="text-sm text-zinc-300 break-all">{file.name}</div>
            <div className="text-[12px] text-zinc-500">
              {file.tooLarge
                ? (L ? 'Файл слишком большой для предпросмотра.' : 'File is too large to preview.')
                : (L ? 'Предпросмотр для этого формата недоступен.' : 'No preview available for this file type.')}
            </div>
            <div className="flex gap-2 mt-1">
              <button
                onClick={() => window.api?.openPath(file.path)}
                className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white text-[12px] cursor-pointer"
              >{L ? 'Открыть в приложении' : 'Open externally'}</button>
              <button
                onClick={() => window.api?.revealInExplorer(file.path)}
                className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[12px] cursor-pointer"
              >{L ? 'Показать в папке' : 'Show in folder'}</button>
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 px-4 py-1 bg-[#0d1117] border-t border-zinc-800/60 text-[11px] text-zinc-500 font-mono shrink-0">
        <span>{kindLabel}</span>
        {file.mime && <span>{file.mime}</span>}
        {dims && <span>{dims.w}×{dims.h}px</span>}
        <span>{formatSize(file.size)}</span>
        {file.kind === 'image' && hasPreview && (
          <span className="text-zinc-600 text-[10px]">{L ? 'Клик — реальный размер / вписать' : 'Click — actual size / fit'}</span>
        )}
        {hasPreview && (
          <button
            onClick={() => window.api?.openPath(file.path)}
            className="ml-auto text-zinc-500 hover:text-blue-400 cursor-pointer"
          >{L ? 'Открыть в приложении' : 'Open externally'}</button>
        )}
      </div>
    </div>
  )
}
