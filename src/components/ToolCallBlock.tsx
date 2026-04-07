import { useState, memo } from 'react'
import { ExternalLinkText } from './ExternalLinkText'

interface Props {
  name: string
  args: Record<string, unknown>
  result?: string
  approvalId?: string
  approvalStatus?: 'pending' | 'approved' | 'denied'
  onApprove?: (id: string) => void
  onDeny?: (id: string) => void
  externalLinksEnabled?: boolean
  onOpenLink?: (url: string) => void
}

const TOOL_ICONS: Record<string, string> = {
  read_file: '○',
  write_file: '●',
  edit_file: '◐',
  list_directory: '◇',
  find_files: '◈',
  execute_command: '▸',
  create_directory: '◇',
  delete_file: '✕',
}

function formatArgs(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'delete_file':
    case 'edit_file':
    case 'create_directory':
      return String(args.path ?? '')
    case 'list_directory':
      return String(args.path ?? '.') + (args.depth ? ` (depth: ${args.depth})` : '')
    case 'find_files':
      return `${args.type === 'content' ? 'grep' : 'glob'}: ${args.pattern}`
    case 'execute_command':
      return String(args.command ?? '')
    default: {
      const first = Object.values(args)[0]
      return typeof first === 'string' ? first : ''
    }
  }
}

export const ToolCallBlock = memo(function ToolCallBlock({
  name,
  args,
  result,
  approvalId,
  approvalStatus,
  onApprove,
  onDeny,
  externalLinksEnabled = true,
  onOpenLink,
}: Props) {
  const [expanded, setExpanded] = useState(false)
  const icon = TOOL_ICONS[name] ?? '◦'
  const brief = formatArgs(name, args)
  const truncBrief = brief.length > 90 ? brief.slice(0, 87) + '…' : brief
  const isError = result?.startsWith('Error:') || result?.startsWith('[Denied')
  const isComplete = result !== undefined
  const isPending = approvalStatus === 'pending'
  const isDenied = approvalStatus === 'denied'

  const statusColor = isDenied
    ? 'text-red-400/70'
    : isComplete
      ? isError ? 'text-red-400/70' : 'text-emerald-400/70'
      : isPending ? 'text-amber-400/70' : 'text-zinc-600'

  const statusIcon = isDenied ? '✕' : isComplete ? (isError ? '✕' : '✓') : isPending ? '⏸' : '…'

  return (
    <div className={`rounded-md overflow-hidden text-xs font-mono ${
      isPending ? 'ring-1 ring-amber-500/30' : ''
    }`}>
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full px-2.5 py-1.5 bg-zinc-800/40 text-left hover:bg-zinc-800/70 transition-colors flex items-center gap-1.5 cursor-pointer group"
      >
        <span className="text-zinc-600 text-[10px] group-hover:text-zinc-400 transition-colors">{icon}</span>
        <span className="text-blue-400/80 font-semibold">{name}</span>
        <span className="text-zinc-600 truncate flex-1 min-w-0">{truncBrief}</span>
        <span className={`${statusColor} shrink-0 text-[10px]`}>{statusIcon}</span>
      </button>

      {isPending && approvalId && (
        <div className="flex items-center gap-2 px-2.5 py-2 bg-amber-500/5 border-t border-amber-500/15">
          <span className="text-[11px] text-amber-300/80 flex-1">Разрешить выполнение?</span>
          <button
            onClick={() => onApprove?.(approvalId)}
            className="px-2.5 py-1 bg-emerald-600/80 hover:bg-emerald-500 text-white text-[11px] rounded font-medium cursor-pointer transition-colors"
          >
            Да
          </button>
          <button
            onClick={() => onDeny?.(approvalId)}
            className="px-2.5 py-1 bg-zinc-700/60 hover:bg-zinc-600 text-zinc-300 text-[11px] rounded font-medium cursor-pointer transition-colors"
          >
            Нет
          </button>
        </div>
      )}

      {expanded && (
        <div className="bg-zinc-950/60 border-t border-zinc-800/40">
          {!isComplete && (
            <pre className="px-2.5 py-1.5 text-zinc-600 text-[11px] whitespace-pre-wrap">
              {JSON.stringify(args, null, 2)}
            </pre>
          )}
          {result && (
            <div className={`px-2.5 py-1.5 text-[11px] whitespace-pre-wrap max-h-60 overflow-y-auto ${
              isError ? 'text-red-400/80' : 'text-zinc-500'
            }`}>
              <ExternalLinkText text={result} externalLinksEnabled={externalLinksEnabled} onOpenLink={onOpenLink} />
            </div>
          )}
        </div>
      )}
    </div>
  )
})
