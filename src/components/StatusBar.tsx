import { useState, useEffect } from 'react'
import type { AppStatus, SystemResources } from '../../electron/types'

interface Props {
  status: AppStatus | null
  /** Last measured tokens per second from LLM stream (shown in status bar). */
  tokensPerSecond?: number | null
}

export function StatusBar({ status, tokensPerSecond }: Props) {
  const [resources, setResources] = useState<SystemResources | null>(null)
  const online = status?.serverRunning && status?.serverHealth?.status === 'ok'

  useEffect(() => {
    window.api?.detectResources().then(setResources).catch(() => {})
  }, [])

  const gpuSummary = resources?.gpus.length
    ? resources.gpus.map((g) => `${g.name} ${(g.vramTotalMb / 1024).toFixed(0)}GB`).join(' + ')
    : null

  return (
    <div className="h-7 bg-zinc-900 border-t border-zinc-800 flex items-center px-4 text-[11px] text-zinc-500 gap-4 shrink-0">
      <div className="flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full ${online ? 'bg-emerald-500' : 'bg-red-500'}`} />
        {online ? 'llama.cpp' : 'offline'}
      </div>
      {status?.modelPath && (
        <span className="truncate text-zinc-600">
          {status.modelPath.split('/').pop()?.replace('.gguf', '')}
        </span>
      )}
      {tokensPerSecond != null && (
        <span className="text-emerald-400" title="Токенов в секунду (последний ответ)">
          {tokensPerSecond} tok/s
        </span>
      )}
      <div className="ml-auto flex items-center gap-3">
        {gpuSummary && <span className="text-zinc-600">{gpuSummary}</span>}
        {resources && <span className="text-zinc-600">{(resources.ramTotalMb / 1024).toFixed(0)}GB RAM</span>}
        <span className="text-zinc-700">v0.1.0</span>
      </div>
    </div>
  )
}
