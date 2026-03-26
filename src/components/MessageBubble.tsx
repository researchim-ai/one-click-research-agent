import { memo, useMemo } from 'react'
import Markdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallBlock } from './ToolCallBlock'
import type { ChatMessage } from '../hooks/useAgent'

interface Props {
  message: ChatMessage
  onApprove?: (id: string) => void
  onDeny?: (id: string) => void
}

const rehypePlugins = [rehypeHighlight] as any[]

const MemoMarkdown = memo(function MemoMarkdown({ content }: { content: string }) {
  return <Markdown rehypePlugins={rehypePlugins}>{content}</Markdown>
})

export const MessageBubble = memo(function MessageBubble({ message, onApprove, onDeny }: Props) {
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
          <MemoMarkdown content={message.content} />
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
