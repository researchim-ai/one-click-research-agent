import { useEffect, useRef, useCallback, useState } from 'react'
import type { AgentEvent, DownloadProgress, AppStatus } from '../../electron/types'
import type { SessionInfo } from '../../electron/agent'

export interface ToolCall {
  name: string
  args: Record<string, unknown>
  result?: string
  approvalId?: string
  approvalStatus?: 'pending' | 'approved' | 'denied'
}

export interface StreamingFile {
  toolName: string
  path: string
  content: string
  done: boolean
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'status'
  content: string
  thinking?: string
  toolCalls?: ToolCall[]
  streamingFile?: StreamingFile
  done?: boolean
}

interface SessionState {
  messages: ChatMessage[]
  idCounter: number
}

export function useAgent() {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)

  const sessionStates = useRef(new Map<string, SessionState>())

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null)
  const [buildStatus, setBuildStatus] = useState<string | null>(null)
  const [workspace, setWorkspaceState] = useState(() => localStorage.getItem('workspace') || '')
  const [contextUsage, setContextUsage] = useState<{ usedTokens: number; budgetTokens: number; maxContextTokens: number; percent: number } | null>(null)
  const [tokensPerSecond, setTokensPerSecond] = useState<number | null>(null)
  const assistantRef = useRef<ChatMessage | null>(null)
  const idCounter = useRef(0)

  const nextId = () => String(++idCounter.current)

  function saveCurrentToMap() {
    if (activeSessionId && workspace) {
      sessionStates.current.set(activeSessionId, {
        messages,
        idCounter: idCounter.current,
      })
      window.api?.saveUiMessages(workspace, activeSessionId, messages).catch(() => {})
    }
  }

  async function loadFromMap(sessionId: string) {
    const state = sessionStates.current.get(sessionId)
    if (state) {
      idCounter.current = state.idCounter
      setMessages(state.messages)
    } else {
      if (!workspace || !window.api) return
      try {
        const saved = await window.api.getUiMessages(workspace, sessionId)
        if (saved && saved.length > 0) {
          const maxId = saved.reduce((max: number, m: any) => Math.max(max, parseInt(m.id) || 0), 0)
          idCounter.current = maxId
          setMessages(saved)
          sessionStates.current.set(sessionId, { messages: saved, idCounter: maxId })
        } else {
          idCounter.current = 0
          setMessages([])
        }
      } catch {
        idCounter.current = 0
        setMessages([])
      }
    }
    assistantRef.current = null
  }

  // When workspace changes: load that project's sessions and active chat (no cross-project mixing)
  useEffect(() => {
    if (!window.api || !workspace.trim()) {
      setSessions([])
      setActiveSessionId(null)
      setMessages([])
      return
    }
    sessionStates.current.clear()
    ;(async () => {
      let list = await window.api.listSessions(workspace)
      const activeId = await window.api.getActiveSessionId(workspace)

      if (list.length === 0) {
        await window.api.createSession(workspace)
        list = await window.api.listSessions(workspace)
      }

      setSessions(list)

      let targetId: string | null = null
      if (activeId && list.some((s: SessionInfo) => s.id === activeId)) {
        targetId = activeId
      } else if (list.length > 0) {
        targetId = list[0].id
        await window.api.switchSession(workspace, list[0].id)
      }

      if (targetId) {
        setActiveSessionId(targetId)
        await loadFromMap(targetId)
      } else {
        setActiveSessionId(null)
        setMessages([])
      }
    })()
  }, [workspace])

  useEffect(() => {
    if (!window.api) return
    const off1 = window.api.onAgentEvent((ev: AgentEvent) => {
      handleAgentEvent(ev)
    })
    const off2 = window.api.onDownloadProgress((p: DownloadProgress) => {
      setDownloadProgress(p)
    })
    const off3 = window.api.onBuildStatus((s: string) => {
      setBuildStatus(s)
    })
    return () => {
      off1(); off2(); off3()
      if (pendingRafRef.current) cancelAnimationFrame(pendingRafRef.current)
      if (throttleTimerRef.current) clearTimeout(throttleTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!window.api) return
    pollStatus()
    const interval = setInterval(pollStatus, 5000)
    return () => clearInterval(interval)
  }, [])

  const pollStatus = async () => {
    try {
      const s = await window.api.getStatus()
      setStatus(s)
    } catch {}
  }

  const refreshSessions = useCallback(async () => {
    if (!workspace || !window.api) return
    try {
      const list = await window.api.listSessions(workspace)
      setSessions(list)
    } catch {}
  }, [workspace])

  // Streaming events (thinking/response) are very frequent — batch with rAF and throttle to avoid blocking editor
  const pendingRafRef = useRef<number | null>(null)
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirtyRef = useRef(false)
  const lastFlushAtRef = useRef(0)
  const FLUSH_THROTTLE_MS = 100

  const flushMessages = useCallback(() => {
    if (!dirtyRef.current) return
    const now = Date.now()
    if (now - lastFlushAtRef.current < FLUSH_THROTTLE_MS) {
      if (!throttleTimerRef.current) {
        throttleTimerRef.current = setTimeout(() => {
          throttleTimerRef.current = null
          lastFlushAtRef.current = Date.now()
          dirtyRef.current = false
          setMessages((prev) => [...prev])
        }, FLUSH_THROTTLE_MS - (now - lastFlushAtRef.current))
      }
      return
    }
    lastFlushAtRef.current = now
    dirtyRef.current = false
    setMessages((prev) => [...prev])
  }, [])

  const handleAgentEvent = useCallback((ev: AgentEvent) => {
    // High-frequency events: mutate in place, batch React updates via rAF
    if (ev.type === 'thinking' || (ev.type === 'response' && !ev.done) || ev.type === 'tool_streaming') {
      const assistant = assistantRef.current
      if (!assistant) return
      if (ev.type === 'thinking') {
        assistant.thinking = (assistant.thinking ?? '') + ev.content
      } else if (ev.type === 'tool_streaming') {
        assistant.streamingFile = {
          toolName: ev.name ?? '',
          path: ev.toolStreamPath ?? '',
          content: ev.toolStreamContent ?? '',
          done: ev.done ?? false,
        }
        if (ev.done) {
          // Clear after a short delay so the UI can show the final state
          setTimeout(() => {
            if (assistant.streamingFile?.done) {
              assistant.streamingFile = undefined
              dirtyRef.current = true
              flushMessages()
            }
          }, 300)
        }
      } else {
        if (ev.content) assistant.content = ev.content
      }
      dirtyRef.current = true
      if (!pendingRafRef.current) {
        pendingRafRef.current = requestAnimationFrame(() => {
          pendingRafRef.current = null
          flushMessages()
        }) as unknown as number
      }
      return
    }

    if (ev.type === 'context_usage') {
      if (ev.contextUsage) setContextUsage(ev.contextUsage)
      return
    }
    if (ev.type === 'stream_stats') {
      if (ev.tokensPerSecond != null) setTokensPerSecond(ev.tokensPerSecond)
      return
    }

    // All other events: immediate state update
    setMessages((prev) => {
      const msgs = [...prev]
      let assistant = msgs.find((m) => m.id === assistantRef.current?.id)

      if (ev.type === 'new_turn') {
        // Finalize the current assistant message and start a fresh one
        if (assistant) {
          assistant.done = true
        }
        const newMsg: ChatMessage = { id: nextId(), role: 'assistant', content: '', toolCalls: [] }
        assistantRef.current = newMsg
        msgs.push(newMsg)
        return msgs
      }

      if (!assistant) {
        assistant = { id: nextId(), role: 'assistant', content: '', toolCalls: [] }
        assistantRef.current = assistant
        msgs.push(assistant)
      }

      switch (ev.type) {
        case 'status':
          msgs.push({ id: nextId(), role: 'status', content: ev.content ?? '' })
          break
        case 'tool_call':
          assistant.toolCalls = [
            ...(assistant.toolCalls ?? []),
            { name: ev.name ?? '', args: ev.args ?? {} },
          ]
          break
        case 'command_approval': {
          const calls = assistant.toolCalls ?? []
          if (calls.length > 0) {
            calls[calls.length - 1].approvalId = ev.approvalId
            calls[calls.length - 1].approvalStatus = 'pending'
          }
          break
        }
        case 'tool_result': {
          const calls = assistant.toolCalls ?? []
          if (calls.length > 0) {
            const last = calls[calls.length - 1]
            last.result = ev.result
            if (last.approvalStatus === 'pending') last.approvalStatus = 'approved'
          }
          break
        }
        case 'response':
          if (ev.content) assistant.content = ev.content
          if (ev.done) {
            assistant.done = true
            assistantRef.current = null
            setBusy(false)
          }
          break
        case 'error':
          msgs.push({ id: nextId(), role: 'status', content: `⚠ ${ev.content}` })
          assistantRef.current = null
          setBusy(false)
          break
      }

      return msgs
    })
  }, [flushMessages])

  const respondApproval = useCallback((approvalId: string, approved: boolean) => {
    window.api.respondApproval(approvalId, approved)
    setMessages((prev) =>
      prev.map((msg) => {
        if (msg.toolCalls) {
          const updated = msg.toolCalls.map((tc) =>
            tc.approvalId === approvalId
              ? { ...tc, approvalStatus: (approved ? 'approved' : 'denied') as 'approved' | 'denied' }
              : tc
          )
          return { ...msg, toolCalls: updated }
        }
        return msg
      })
    )
  }, [])

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || busy) return
    setMessages((prev) => {
      const userMsg: ChatMessage = { id: nextId(), role: 'user', content: text }
      const assistantMsg: ChatMessage = { id: nextId(), role: 'assistant', content: '', toolCalls: [] }
      assistantRef.current = assistantMsg
      return [...prev, userMsg, assistantMsg]
    })
    setBusy(true)
    try {
      await window.api.sendMessage(text, workspace)
    } catch (e: any) {
      setMessages((prev) => [...prev, { id: nextId(), role: 'status', content: `⚠ ${e.message ?? e}` }])
      setBusy(false)
    }
    refreshSessions()
  }, [busy, workspace, refreshSessions])

  const cancel = useCallback(async () => {
    try {
      await window.api.cancelAgent()
    } catch {}
    setBusy(false)
  }, [])

  const setWorkspace = useCallback((ws: string) => {
    setWorkspaceState(ws)
    localStorage.setItem('workspace', ws)
    window.api.setWorkspace(ws)
  }, [])

  const resetChat = useCallback(() => {
    setMessages([])
    assistantRef.current = null
    idCounter.current = 0
    if (activeSessionId && workspace) {
      sessionStates.current.set(activeSessionId, { messages: [], idCounter: 0 })
      window.api.saveUiMessages(workspace, activeSessionId, []).catch(() => {})
    }
    window.api.resetAgent(workspace)
    refreshSessions()
  }, [activeSessionId, workspace, refreshSessions])

  // ---------------------------------------------------------------------------
  // Session actions
  // ---------------------------------------------------------------------------

  const newSession = useCallback(async () => {
    if (busy || !workspace) return
    saveCurrentToMap()
    const id = await window.api.createSession(workspace)
    setActiveSessionId(id)
    setMessages([])
    assistantRef.current = null
    idCounter.current = 0
    await refreshSessions()
  }, [busy, workspace, activeSessionId, messages, refreshSessions])

  const switchToSession = useCallback(async (id: string) => {
    if (busy || !workspace || id === activeSessionId) return
    saveCurrentToMap()
    const ok = await window.api.switchSession(workspace, id)
    if (ok) {
      setActiveSessionId(id)
      loadFromMap(id)
    }
  }, [busy, workspace, activeSessionId, messages])

  const removeSession = useCallback(async (id: string) => {
    if (busy || !workspace) return
    await window.api.deleteSession(workspace, id)
    sessionStates.current.delete(id)

    if (id === activeSessionId) {
      const remaining = sessions.filter((s) => s.id !== id)
      if (remaining.length > 0) {
        const next = remaining[0]
        await window.api.switchSession(workspace, next.id)
        setActiveSessionId(next.id)
        loadFromMap(next.id)
      } else {
        const newId = await window.api.createSession(workspace)
        setActiveSessionId(newId)
        setMessages([])
        assistantRef.current = null
        idCounter.current = 0
      }
    }
    await refreshSessions()
  }, [busy, workspace, activeSessionId, sessions, refreshSessions])

  const renameActiveSession = useCallback(async (title: string) => {
    if (!activeSessionId || !workspace) return
    await window.api.renameSession(workspace, activeSessionId, title)
    await refreshSessions()
  }, [activeSessionId, workspace, refreshSessions])

  // Persist messages to map + debounced disk save
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (activeSessionId && workspace) {
      sessionStates.current.set(activeSessionId, {
        messages,
        idCounter: idCounter.current,
      })

      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => {
        window.api?.saveUiMessages(workspace, activeSessionId, messages).catch(() => {})
      }, 500)
    }
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [messages, activeSessionId, workspace])

  return {
    messages, busy, status, downloadProgress, buildStatus,
    workspace, setWorkspace, contextUsage, tokensPerSecond,
    sendMessage, resetChat, pollStatus, respondApproval, cancel,
    sessions, activeSessionId,
    newSession, switchToSession, removeSession, renameActiveSession,
  }
}
