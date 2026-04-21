import { useRef, useEffect, useState, useCallback, type KeyboardEvent } from 'react'
import { MessageBubble } from './MessageBubble'
import type { ChatMessage } from '../hooks/useAgent'

interface AttachedFile {
  path: string
  name: string
}

export interface CodeReference {
  filePath: string
  relativePath: string
  startLine: number
  endLine: number
  content: string
  language: string
}

interface ContextUsage {
  usedTokens: number
  budgetTokens: number
  maxContextTokens: number
  percent: number
}

interface Props {
  messages: ChatMessage[]
  busy: boolean
  workspace: string
  onSend: (text: string) => void
  onCancel?: () => void
  onApproval?: (id: string, approved: boolean) => void
  codeRefs?: CodeReference[]
  onRemoveCodeRef?: (index: number) => void
  contextUsage?: ContextUsage | null
  externalLinksEnabled?: boolean
  onOpenExternalLink?: (url: string) => void
  appLanguage?: 'ru' | 'en'
  onCitationClick?: (n: number) => void
}

export function Chat({
  messages,
  busy,
  workspace,
  onSend,
  onCancel,
  onApproval,
  codeRefs = [],
  onRemoveCodeRef,
  contextUsage,
  externalLinksEnabled = true,
  onOpenExternalLink,
  appLanguage = 'ru',
  onCitationClick,
}: Props) {
  const L = appLanguage === 'ru'
  const [input, setInput] = useState('')
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([])
  const [showMention, setShowMention] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [mentionFiles, setMentionFiles] = useState<{ path: string; name: string }[]>([])
  const [mentionIndex, setMentionIndex] = useState(0)
  const [expandedRef, setExpandedRef] = useState<number | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const lastScrollLenRef = useRef(0)
  const lastScrollIdRef = useRef<string | null>(null)

  useEffect(() => {
    const len = messages.length
    const lastId = len > 0 ? messages[len - 1].id : null
    const shouldScroll = len !== lastScrollLenRef.current || lastId !== lastScrollIdRef.current
    lastScrollLenRef.current = len
    lastScrollIdRef.current = lastId
    if (shouldScroll) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages])

  const handleSend = useCallback(async () => {
    if (!input.trim() && attachedFiles.length === 0 && codeRefs.length === 0) return
    if (busy) return

    let fullMessage = ''

    // Code references first (more specific context)
    if (codeRefs.length > 0) {
      const parts: string[] = []
      for (const ref of codeRefs) {
        parts.push(
          `[${ref.relativePath}:${ref.startLine}-${ref.endLine}]\n\`\`\`${ref.language}\n${ref.content}\n\`\`\``
        )
      }
      fullMessage = parts.join('\n\n') + '\n\n'
    }

    // Then full files
    if (attachedFiles.length > 0) {
      const parts: string[] = []
      for (const f of attachedFiles) {
        try {
          const { content } = await window.api.readFileContent(f.path)
          const lines = content.split('\n').length
          parts.push(`[File: ${f.name}] (${lines} lines)\n\`\`\`\n${content}\n\`\`\``)
        } catch {
          parts.push(`[File: ${f.name}] (failed to read)`)
        }
      }
      fullMessage += parts.join('\n\n') + '\n\n'
    }

    fullMessage += input.trim()

    onSend(fullMessage)
    setInput('')
    setAttachedFiles([])
    setExpandedRef(null)
    // Clear code refs via parent
    if (onRemoveCodeRef) {
      for (let i = codeRefs.length - 1; i >= 0; i--) onRemoveCodeRef(i)
    }
    setShowMention(false)
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }, [input, attachedFiles, codeRefs, busy, onSend, onRemoveCodeRef])

  const collectFiles = useCallback(async (query: string) => {
    if (!workspace || !window.api) return
    try {
      const tree = await window.api.listFiles(workspace)
      const results: { path: string; name: string }[] = []
      const q = query.toLowerCase()

      const walk = (entries: typeof tree, prefix: string) => {
        for (const e of entries) {
          const rel = prefix ? `${prefix}/${e.name}` : e.name
          if (!e.isDir && rel.toLowerCase().includes(q)) {
            results.push({ path: e.path, name: rel })
            if (results.length >= 12) return
          }
          if (e.isDir && e.children) walk(e.children, rel)
          if (results.length >= 12) return
        }
      }
      walk(tree, '')
      setMentionFiles(results)
      setMentionIndex(0)
    } catch {
      setMentionFiles([])
    }
  }, [workspace])

  const handleInput = (val: string) => {
    setInput(val)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px'
    }

    const cursor = textareaRef.current?.selectionStart ?? val.length
    const before = val.slice(0, cursor)
    const atMatch = before.match(/@([^\s@]*)$/)

    if (atMatch) {
      setShowMention(true)
      setMentionQuery(atMatch[1])
      collectFiles(atMatch[1])
    } else {
      setShowMention(false)
    }
  }

  const insertFile = (file: { path: string; name: string }) => {
    if (attachedFiles.some((f) => f.path === file.path)) {
      setShowMention(false)
      return
    }
    setAttachedFiles((prev) => [...prev, { path: file.path, name: file.name }])

    const cursor = textareaRef.current?.selectionStart ?? input.length
    const before = input.slice(0, cursor)
    const after = input.slice(cursor)
    const cleaned = before.replace(/@[^\s@]*$/, '') + after
    setInput(cleaned)
    setShowMention(false)
    textareaRef.current?.focus()
  }

  const removeFile = (path: string) => {
    setAttachedFiles((prev) => prev.filter((f) => f.path !== path))
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (showMention && mentionFiles.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIndex((i) => Math.min(i + 1, mentionFiles.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIndex((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        insertFile(mentionFiles[mentionIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setShowMention(false)
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const noWorkspace = !workspace
  const hasAttachments = attachedFiles.length > 0 || codeRefs.length > 0

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-5 py-5 min-h-0">
        <div className="flex flex-col gap-5">
          {messages.length === 0 && (
            <div className="text-center py-20 text-zinc-500">
              <div className="text-5xl mb-4">⚡</div>
              <h2 className="text-2xl font-bold text-zinc-200 mb-2">Research Agent</h2>
              <p className="text-base max-w-md mx-auto leading-relaxed mb-6">
                {L
                  ? <>Локальный AI-агент для исследования и воспроизведения.<br />Анализирует файлы, документы, репозитории и результаты запусков.</>
                  : <>Local AI agent for research and reproduction.<br />Analyzes files, documents, repositories, and run results.</>}
              </p>
              {noWorkspace ? (
                <div className="inline-flex items-center gap-2 px-4 py-2 bg-amber-500/10 border border-amber-500/30 rounded-lg text-sm text-amber-400">
                  <span>📁</span> {L ? 'Выбери рабочую директорию в боковой панели' : 'Select a working directory in the sidebar'}
                </div>
              ) : (
                <div className="space-y-2 text-sm text-zinc-500">
                  <p>{L ? 'Примеры задач:' : 'Example tasks:'}</p>
                  <div className="flex flex-wrap justify-center gap-2">
                    {(L ? [
                      'Изучи проект и опиши архитектуру',
                      'Собери research brief по теме…',
                      'Сравни несколько подходов и выдели риски',
                      'Попробуй воспроизвести paper или open-source проект',
                    ] : [
                      'Explore the project and describe its architecture',
                      'Compile a research brief on a topic…',
                      'Compare several approaches and highlight risks',
                      'Try to reproduce a paper or open-source project',
                    ]).map((ex) => (
                      <button
                        key={ex}
                        onClick={() => { setInput(ex); textareaRef.current?.focus() }}
                        className="px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg hover:border-blue-500 hover:text-blue-300 transition-colors cursor-pointer"
                      >
                        {ex}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {messages.map((msg) => {
            const isDone = msg.role === 'status' || msg.done === true || msg.role === 'user'
            return (
              <div key={msg.id} className={isDone ? 'msg-auto-contain' : undefined}>
                <MessageBubble
                  message={msg}
                  onApprove={onApproval ? (id) => onApproval(id, true) : undefined}
                  onDeny={onApproval ? (id) => onApproval(id, false) : undefined}
                  externalLinksEnabled={externalLinksEnabled}
                  onOpenLink={onOpenExternalLink}
                  onCitationClick={onCitationClick}
                />
              </div>
            )
          })}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Context usage bar */}
      {contextUsage && (
        <div className="border-t border-zinc-800/40 bg-[#0d1117] px-3 py-1 flex items-center gap-2">
          <span className="text-[10px] text-zinc-600 shrink-0">{L ? 'Контекст' : 'Context'}</span>
          <div className="flex-1 h-1.5 bg-zinc-800/80 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                contextUsage.percent > 85 ? 'bg-red-500' :
                contextUsage.percent > 60 ? 'bg-amber-500' :
                'bg-emerald-500'
              }`}
              style={{ width: `${Math.min(contextUsage.percent, 100)}%` }}
            />
          </div>
          <span className={`text-[10px] font-mono tabular-nums shrink-0 ${
            contextUsage.percent > 85 ? 'text-red-400' :
            contextUsage.percent > 60 ? 'text-amber-400' :
            'text-zinc-500'
          }`}>
            {contextUsage.percent}%
          </span>
          <span className="text-[9px] text-zinc-700 shrink-0">
            {Math.round(contextUsage.usedTokens / 1024)}K / {Math.round(contextUsage.maxContextTokens / 1024)}K
          </span>
        </div>
      )}

      {/* Agent working indicator */}
      {busy && (
        <div className="flex items-center gap-2 px-4 py-1.5 border-t border-zinc-800/40 bg-[#0d1117]">
          <span className="flex gap-1">
            <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-[pulse-dot_1.4s_0s_infinite]" />
            <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-[pulse-dot_1.4s_0.2s_infinite]" />
            <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-[pulse-dot_1.4s_0.4s_infinite]" />
          </span>
          <span className="text-[11px] text-zinc-500">{L ? 'Агент работает…' : 'Agent working…'}</span>
          {onCancel && (
            <button
              onClick={onCancel}
              className="ml-auto px-2.5 py-0.5 rounded-full border border-zinc-700 text-[11px] text-zinc-400 hover:text-red-400 hover:border-red-500/40 hover:bg-red-500/10 cursor-pointer transition-colors"
            >
              {L ? '⏹ Остановить' : '⏹ Stop'}
            </button>
          )}
        </div>
      )}

      {/* Input area */}
      <div className="border-t border-zinc-800/60 bg-[#0d1117]">
        {/* Attached code references */}
        {codeRefs.length > 0 && (
          <div className="flex flex-col gap-1.5 px-3 pt-2.5 pb-1">
            {codeRefs.map((ref, i) => (
              <div key={`${ref.filePath}:${ref.startLine}:${ref.endLine}`} className="group">
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setExpandedRef(expandedRef === i ? null : i)}
                    className="flex-1 min-w-0 inline-flex items-center gap-1.5 px-2.5 py-1 bg-purple-500/8 border border-purple-500/25 rounded text-[11px] font-mono text-left hover:bg-purple-500/12 transition-colors cursor-pointer"
                  >
                    <span className="text-purple-400 text-[10px]">{'<>'}</span>
                    <span className="text-purple-300 truncate">{ref.relativePath}</span>
                    <span className="text-purple-400/50">:</span>
                    <span className="text-purple-200/80">{ref.startLine === ref.endLine ? `L${ref.startLine}` : `L${ref.startLine}–${ref.endLine}`}</span>
                    <span className="text-zinc-600 text-[10px] ml-auto shrink-0">
                      {ref.endLine - ref.startLine + 1} {pluralLines(ref.endLine - ref.startLine + 1, appLanguage)}
                    </span>
                    <span className="text-zinc-600 text-[10px]">{expandedRef === i ? '▾' : '▸'}</span>
                  </button>
                  {onRemoveCodeRef && (
                    <button
                      onClick={() => onRemoveCodeRef(i)}
                      className="w-5 h-5 flex items-center justify-center rounded text-zinc-600 hover:text-red-400 hover:bg-red-500/10 cursor-pointer text-[10px] shrink-0 transition-colors"
                    >
                      ✕
                    </button>
                  )}
                </div>
                {expandedRef === i && (
                  <div className="mt-1 ml-0.5 rounded border border-purple-500/15 bg-[#0d1117] overflow-hidden">
                    <pre className="p-2 text-[11px] leading-[16px] font-mono text-zinc-400 overflow-x-auto max-h-[150px] overflow-y-auto">
                      {ref.content.split('\n').map((line, li) => (
                        <div key={li} className="flex">
                          <span className="text-zinc-700 select-none w-8 text-right pr-2 shrink-0">{ref.startLine + li}</span>
                          <span className="text-zinc-300">{line || '\u00A0'}</span>
                        </div>
                      ))}
                    </pre>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Attached files */}
        {attachedFiles.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-2.5 pb-1">
            {attachedFiles.map((f) => (
              <span
                key={f.path}
                className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-500/10 border border-blue-500/30 rounded text-[11px] text-blue-300 font-mono"
              >
                <span className="text-blue-400/60">@</span>
                <span className="max-w-[180px] truncate">{f.name}</span>
                <button
                  onClick={() => removeFile(f.path)}
                  className="ml-0.5 text-blue-400/50 hover:text-blue-300 cursor-pointer text-[10px]"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Mention dropdown */}
        <div className="relative">
          {showMention && mentionFiles.length > 0 && (
            <div className="absolute bottom-full left-0 right-0 mx-3 mb-1 bg-zinc-900 border border-zinc-700/60 rounded-lg shadow-xl overflow-hidden z-50 max-h-[240px] overflow-y-auto">
              <div className="px-2.5 py-1.5 text-[10px] text-zinc-500 uppercase tracking-wider border-b border-zinc-800/60">
                {L ? 'Файлы проекта' : 'Project files'}
              </div>
              {mentionFiles.map((f, i) => (
                <button
                  key={f.path}
                  onMouseDown={(e) => { e.preventDefault(); insertFile(f) }}
                  className={`w-full px-2.5 py-1.5 text-left text-[12px] font-mono flex items-center gap-2 cursor-pointer ${
                    i === mentionIndex
                      ? 'bg-blue-500/15 text-blue-300'
                      : 'text-zinc-400 hover:bg-zinc-800/60'
                  }`}
                >
                  <span className="text-zinc-600">@</span>
                  <span className="truncate">{f.name}</span>
                </button>
              ))}
            </div>
          )}

          {/* Input row */}
          <div className="flex items-end">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => handleInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={busy || noWorkspace}
              placeholder={noWorkspace
                ? (L ? 'Сначала выбери проект ←' : 'Select a project first ←')
                : hasAttachments
                  ? (L ? 'Добавь описание задачи…' : 'Describe the task…')
                  : (L ? 'Опиши задачу… @ — прикрепить файл' : 'Describe a task… @ — attach file')}
              rows={1}
              className="flex-1 bg-transparent px-3 py-2.5 text-[13px] text-zinc-100 placeholder-zinc-600 resize-none focus:outline-none disabled:opacity-50"
            />
            <button
              onClick={handleSend}
              disabled={busy || (!input.trim() && !hasAttachments) || noWorkspace}
              className="w-8 h-8 flex items-center justify-center text-zinc-500 hover:text-blue-400 disabled:opacity-20 disabled:cursor-not-allowed transition-colors shrink-0 cursor-pointer text-sm mr-1.5 mb-1"
            >
              ➤
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function pluralLines(n: number, lang: 'ru' | 'en' = 'ru'): string {
  if (lang === 'en') return n === 1 ? 'line' : 'lines'
  if (n % 10 === 1 && n % 100 !== 11) return 'строка'
  if ([2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)) return 'строки'
  return 'строк'
}
