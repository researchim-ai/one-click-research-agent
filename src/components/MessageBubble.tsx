import { memo, useMemo, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallBlock } from './ToolCallBlock'
import type { ChatMessage } from '../hooks/useAgent'
import { normalizeExternalHttpUrl } from '../utils/external-links'

interface Props {
  message: ChatMessage
  onApprove?: (id: string) => void
  onDeny?: (id: string) => void
  externalLinksEnabled?: boolean
  onOpenLink?: (url: string) => void
  onCitationClick?: (n: number) => void
}

const rehypePlugins = [rehypeHighlight] as any[]
const remarkPlugins = [remarkGfm] as any[]

/**
 * Split text into React nodes, converting tokens like "[1]" / "[1, 3-5]" into
 * inline citation chips. Paired with `SourcesPanel`, so users can see what
 * `[n]` refers to without leaving the chat.
 */
const CITATION_RE = /\[([0-9]{1,3}(?:\s*[,–-]\s*[0-9]{1,3})*)\]/g
function renderCitationChildren(children: ReactNode, onCitation?: (n: number) => void): ReactNode {
  if (!onCitation) return children
  const toChips = (text: string): ReactNode[] => {
    const out: ReactNode[] = []
    let last = 0
    text.replace(CITATION_RE, (match, ids: string, offset: number) => {
      if (offset > last) out.push(text.slice(last, offset))
      const nums: number[] = []
      for (const part of ids.split(',')) {
        const p = part.trim()
        const range = p.match(/^(\d+)\s*[–-]\s*(\d+)$/)
        if (range) {
          const a = Number(range[1]); const b = Number(range[2])
          if (a && b && a <= b && b - a < 20) {
            for (let k = a; k <= b; k++) nums.push(k)
          }
        } else {
          const n = Number(p)
          if (n) nums.push(n)
        }
      }
      if (nums.length === 0) {
        out.push(match)
      } else {
        out.push(
          <span key={`${offset}-${match}`} className="inline-flex items-center gap-px align-baseline">
            {nums.map((n, i) => (
              <button
                key={`${offset}-${n}-${i}`}
                type="button"
                onClick={() => onCitation(n)}
                className="mx-px px-1 py-px rounded bg-blue-500/10 border border-blue-500/30 text-[10px] font-mono text-blue-300 hover:bg-blue-500/20 hover:text-blue-200 cursor-pointer"
                title={`Source [${n}]`}
              >
                [{n}]
              </button>
            ))}
          </span>
        )
      }
      last = offset + match.length
      return match
    })
    if (last < text.length) out.push(text.slice(last))
    return out
  }
  const mapNode = (node: ReactNode): ReactNode => {
    if (typeof node === 'string') return toChips(node)
    if (Array.isArray(node)) return node.map((n, i) => <span key={i}>{mapNode(n)}</span>)
    return node
  }
  return mapNode(children)
}

const MemoMarkdown = memo(function MemoMarkdown({
  content,
  externalLinksEnabled,
  onOpenLink,
  onCitation,
}: {
  content: string
  externalLinksEnabled: boolean
  onOpenLink?: (url: string) => void
  onCitation?: (n: number) => void
}) {
  return (
    <Markdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={{
        a: ({ href, children }) => {
          const safeUrl = normalizeExternalHttpUrl(href)
          if (!safeUrl || !externalLinksEnabled) {
            return <span className="text-blue-300 underline decoration-dotted">{children}</span>
          }
          return (
            <button
              type="button"
              onClick={() => onOpenLink?.(safeUrl)}
              className="text-blue-300 underline decoration-blue-400/50 underline-offset-2 hover:text-blue-200 cursor-pointer break-all text-left"
              title={safeUrl}
            >
              {children}
            </button>
          )
        },
        p: ({ children }) => <p>{renderCitationChildren(children, onCitation)}</p>,
        li: ({ children }) => <li>{renderCitationChildren(children, onCitation)}</li>,
      }}
    >
      {content}
    </Markdown>
  )
})

export const MessageBubble = memo(function MessageBubble({
  message,
  onApprove,
  onDeny,
  externalLinksEnabled = true,
  onOpenLink,
  onCitationClick,
}: Props) {
  if (message.role === 'status') {
    return (
      <div className="text-center text-zinc-600 text-[11px] py-0.5 animate-[fadeIn_0.2s] font-mono">
        {message.content}
      </div>
    )
  }

  if (message.role === 'user') {
    return (
      <div className="self-end max-w-[85%] animate-[fadeIn_0.2s]">
        <div className="bg-blue-600/90 text-white px-4 py-2.5 rounded-2xl rounded-br-sm text-[13.5px] leading-relaxed whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    )
  }

  // Assistant message
  const hasContent = !!message.content
  const hasTools = !!(message.toolCalls?.length)
  const hasThinking = !!message.thinking
  const hasStreaming = !!message.streamingFile
  const isLoading = !message.done && !hasContent && !hasTools && !hasThinking && !hasStreaming
  const thinkingLive = hasThinking && !message.done && !hasContent

  // Skip completely empty completed turns (no content, no tools, no thinking)
  if (message.done && !hasContent && !hasTools && !hasThinking) return null

  const streamLines = useMemo(() => {
    if (!message.streamingFile?.content) return 0
    return message.streamingFile.content.split('\n').length
  }, [message.streamingFile?.content])

  return (
    <div className="self-start max-w-full animate-[fadeIn_0.2s]">
      {hasThinking && <ThinkingBlock content={message.thinking!} live={thinkingLive} />}

      {hasTools && (
        <div className="space-y-1 my-1">
          {message.toolCalls!.map((tc, i) => (
            <ToolCallBlock
              key={i}
              name={tc.name}
              args={tc.args}
              result={tc.result}
              approvalId={tc.approvalId}
              approvalStatus={tc.approvalStatus}
              onApprove={onApprove}
              onDeny={onDeny}
              externalLinksEnabled={externalLinksEnabled}
              onOpenLink={onOpenLink}
            />
          ))}
        </div>
      )}

      {hasStreaming && (
        <div className="my-1.5 rounded-lg border border-zinc-800 overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900/80 border-b border-zinc-800">
            <span className="text-green-400 text-xs">
              {message.streamingFile!.toolName === 'edit_file' ? '✏️' : message.streamingFile!.toolName === 'append_file' ? '📎' : '📝'}
            </span>
            <span className="text-[11px] text-zinc-400 font-mono truncate">{message.streamingFile!.path || '...'}</span>
            <span className="text-[10px] text-zinc-600 ml-auto shrink-0">{streamLines} строк</span>
            {!message.streamingFile!.done && (
              <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse shrink-0" />
            )}
          </div>
          <pre className="px-3 py-2 text-[12px] leading-[1.5] text-zinc-300 bg-zinc-950/50 max-h-[300px] overflow-y-auto font-mono whitespace-pre-wrap break-all">{message.streamingFile!.content}</pre>
        </div>
      )}

      {hasContent && (
        <div className="agent-prose mt-1">
          <MemoMarkdown content={message.content} externalLinksEnabled={externalLinksEnabled} onOpenLink={onOpenLink} onCitation={onCitationClick} />
        </div>
      )}

      {isLoading && (
        <div className="flex gap-1.5 py-2 px-1">
          <span className="w-1.5 h-1.5 bg-zinc-600 rounded-full animate-[pulse-dot_1.4s_0s_infinite]" />
          <span className="w-1.5 h-1.5 bg-zinc-600 rounded-full animate-[pulse-dot_1.4s_0.2s_infinite]" />
          <span className="w-1.5 h-1.5 bg-zinc-600 rounded-full animate-[pulse-dot_1.4s_0.4s_infinite]" />
        </div>
      )}
    </div>
  )
})
