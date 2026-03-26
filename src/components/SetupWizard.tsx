import { useState, useEffect, useRef } from 'react'
import type { AppStatus, DownloadProgress, ModelVariantInfo } from '../../electron/types'

interface Props {
  status: AppStatus | null
  downloadProgress: DownloadProgress | null
  buildStatus: string | null
  onComplete: () => void
}

type Phase = 'idle' | 'installing' | 'downloading' | 'starting' | 'done' | 'error'

const DEFAULT_QUANT = 'UD-Q4_K_XL'

const CTX_OPTIONS = [
  { value: 262144, label: '262K' },
  { value: 131072, label: '131K' },
  { value: 65536,  label: '65K' },
  { value: 32768,  label: '32K' },
  { value: 16384,  label: '16K' },
  { value: 8192,   label: '8K' },
  { value: 4096,   label: '4K' },
]

function formatSize(mb: number): string {
  return (mb / 1024).toFixed(1) + ' ГБ'
}

function formatCtx(tokens: number): string {
  if (tokens >= 1024) return Math.round(tokens / 1024) + 'K'
  return String(tokens)
}

const BITS_COLOR: Record<number, string> = {
  2: 'text-red-400',
  3: 'text-orange-400',
  4: 'text-yellow-300',
  5: 'text-lime-400',
  6: 'text-emerald-400',
  8: 'text-cyan-400',
}

export function SetupWizard({ status, downloadProgress, buildStatus, onComplete }: Props) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [startTime, setStartTime] = useState<number | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  const [variants, setVariants] = useState<ModelVariantInfo[]>([])
  const [selectedQuant, setSelectedQuant] = useState(DEFAULT_QUANT)
  const [selectedCtx, setSelectedCtx] = useState<number>(32768)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [ctxDropdownOpen, setCtxDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const ctxDropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    Promise.all([
      window.api.getModelVariants(),
      window.api.getConfig(),
    ]).then(([v, cfg]) => {
      setVariants(v)
      const recommended = v.find((vi: ModelVariantInfo) => vi.recommended)
      let quant = recommended?.quant ?? DEFAULT_QUANT
      if (cfg.lastQuant && v.some((vi: ModelVariantInfo) => vi.quant === cfg.lastQuant && vi.fits)) {
        quant = cfg.lastQuant
      }
      setSelectedQuant(quant)
      window.api.selectModelVariant(quant).catch(() => {})
      const variant = v.find((vi: ModelVariantInfo) => vi.quant === quant)
      const max = variant?.maxCtx ?? 32768
      if (cfg.ctxSize && cfg.ctxSize > 0) {
        setSelectedCtx(Math.min(cfg.ctxSize, max))
      } else {
        setSelectedCtx(max)
        window.api.saveConfig({ ctxSize: max }).catch(() => {})
      }
    }).catch(() => {})
  }, [])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
      if (ctxDropdownRef.current && !ctxDropdownRef.current.contains(e.target as Node)) {
        setCtxDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const selected = variants.find((v) => v.quant === selectedQuant)

  const handleSelectVariant = async (quant: string) => {
    setSelectedQuant(quant)
    setDropdownOpen(false)
    const v = variants.find((vi) => vi.quant === quant)
    const newMax = v?.maxCtx ?? 32768
    const newCtx = Math.min(selectedCtx, newMax)
    setSelectedCtx(newCtx)
    await window.api.selectModelVariant(quant).catch(() => {})
    await window.api.saveConfig({ lastQuant: quant, ctxSize: newCtx }).catch(() => {})
  }

  const handleSelectCtx = async (value: number) => {
    setSelectedCtx(value)
    setCtxDropdownOpen(false)
    await window.api.saveConfig({ ctxSize: value }).catch(() => {})
  }

  const addLog = (msg: string) => {
    setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`])
  }

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logs])

  useEffect(() => {
    if (buildStatus && (phase === 'installing' || phase === 'starting')) addLog(buildStatus)
  }, [buildStatus])

  useEffect(() => {
    if (downloadProgress && phase === 'downloading') {
      if (downloadProgress.totalMb > 0) {
        addLog(`\u{1F4E5} ${downloadProgress.status}`)
      } else if (downloadProgress.status) {
        addLog(downloadProgress.status)
      }
    }
  }, [downloadProgress?.status])

  const handleStart = async () => {
    setPhase('installing')
    setError(null)
    setLogs([])
    setStartTime(Date.now())

    try {
      if (!status?.llamaReady) {
        addLog('\u{1F50D} Определение оптимального бинарника для вашей системы…')
        await window.api.ensureLlama()
        addLog('\u2705 llama-server установлен!')
      } else {
        addLog('\u2705 llama-server уже установлен — пропускаем')
      }

      setPhase('downloading')
      if (!status?.modelDownloaded) {
        addLog(`\u{1F4E5} Начинаем скачивание модели (${selectedQuant})…`)
        const modelPath = await window.api.downloadModel()
        addLog(`\u2705 Модель скачана: ${modelPath.split(/[\\/]/).pop()}`)
      } else {
        addLog('\u2705 Модель уже скачана — пропускаем')
      }

      setPhase('starting')
      addLog('\u{1F680} Запускаем llama-server…')
      await window.api.startServer()
      addLog('\u2705 Сервер запущен и готов к работе!')

      setPhase('done')
    } catch (e: any) {
      const msg = e.message ?? String(e)
      setError(msg)
      addLog(`\u274C Ошибка: ${msg}`)
      setPhase('error')
    }
  }

  const elapsed = startTime ? Math.round((Date.now() - startTime) / 1000) : 0
  const elapsedStr = elapsed > 0 ? `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}` : ''

  const selectedSize = selected ? formatSize(selected.sizeMb) : '~20 ГБ'
  const maxCtx = selected?.maxCtx ?? 262144
  const displayCtx = formatCtx(selectedCtx)
  const availableCtxOptions = CTX_OPTIONS.filter((o) => o.value <= maxCtx)

  const steps = [
    {
      key: 'install',
      label: 'Скачивание llama-server',
      desc: 'Готовый бинарник с GitHub Releases (~30–200 МБ)',
      active: phase === 'installing',
      done: phase !== 'idle' && phase !== 'installing' && phase !== 'error',
      detail: phase === 'installing' ? buildStatus : null,
    },
    {
      key: 'download',
      label: 'Скачивание модели',
      desc: `Qwen3.5-${selectedQuant.startsWith('9B-') ? '9B' : '35B-A3B'} · ${selectedQuant.replace(/^9B-/, '').replace('UD-', '')} (~${selectedSize}) · ctx ${displayCtx}`,
      active: phase === 'downloading',
      done: ['starting', 'done'].includes(phase),
      detail: phase === 'downloading' ? downloadProgress?.status : null,
    },
    {
      key: 'server',
      label: 'Запуск inference-сервера',
      desc: 'Загрузка модели в VRAM и старт API',
      active: phase === 'starting',
      done: phase === 'done',
      detail: phase === 'starting' ? (buildStatus ?? 'Ожидание готовности…') : null,
    },
  ]

  const isRunning = phase !== 'idle' && phase !== 'done' && phase !== 'error'

  return (
    <div className="flex-1 flex items-center justify-center p-6 overflow-y-auto">
      <div className="max-w-2xl w-full">

        {/* Header */}
        <div className="text-center mb-8">
          <div className="text-6xl mb-3">{'⚡'}</div>
          <h1 className="text-3xl font-bold text-zinc-100 mb-2">One-Click Research Agent</h1>
          <p className="text-zinc-400">
            Qwen3.5 <span className="text-zinc-500">{'·'}</span>{' '}
            <span className="text-zinc-300">{selectedQuant.replace(/^9B-/, '').replace('UD-', '')}</span>{' '}
            <span className="text-zinc-500">{'·'}</span>{' '}
            {selectedQuant.startsWith('9B-') ? '9B' : '35B-A3B'}{' '}
            <span className="text-zinc-500">{'·'}</span>{' '}
            ctx {displayCtx}{' '}
            <span className="text-zinc-500">{'·'}</span> локально через llama.cpp
          </p>
        </div>

        {/* Steps */}
        <div className="space-y-3 mb-6">
          {steps.map((step, i) => (
            <div
              key={step.key}
              className={`relative flex items-start gap-4 px-5 py-4 rounded-xl border transition-all duration-300 ${
                step.done
                  ? 'border-emerald-500/40 bg-emerald-500/5'
                  : step.active
                    ? 'border-blue-500/40 bg-blue-500/5 shadow-lg shadow-blue-500/5'
                    : 'border-zinc-800 bg-zinc-900/50'
              }`}
            >
              <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold shrink-0 transition-all duration-300 ${
                step.done
                  ? 'bg-emerald-500 text-white'
                  : step.active
                    ? 'bg-blue-500 text-white animate-pulse'
                    : 'bg-zinc-800 text-zinc-500'
              }`}>
                {step.done ? '\u2713' : i + 1}
              </div>

              <div className="flex-1 min-w-0">
                <p className={`text-sm font-semibold transition-colors ${
                  step.done ? 'text-emerald-400' : step.active ? 'text-blue-300' : 'text-zinc-400'
                }`}>
                  {step.label}
                </p>
                <p className="text-xs text-zinc-500 mt-0.5">{step.desc}</p>

                {step.active && step.detail && (
                  <p className="text-xs text-blue-400 mt-2 font-mono animate-pulse">{step.detail}</p>
                )}

                {step.key === 'download' && step.active && downloadProgress && downloadProgress.totalMb > 0 && (
                  <div className="mt-3">
                    <div className="flex justify-between text-xs text-zinc-500 mb-1">
                      <span>{downloadProgress.downloadedMb.toLocaleString()} / {downloadProgress.totalMb.toLocaleString()} МБ</span>
                      <span>{downloadProgress.percent.toFixed(1)}%</span>
                    </div>
                    <div className="w-full h-2.5 bg-zinc-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-blue-600 to-blue-400 rounded-full transition-all duration-500 ease-out"
                        style={{ width: `${Math.min(downloadProgress.percent, 100)}%` }}
                      />
                    </div>
                  </div>
                )}

                {step.key === 'install' && step.active && (
                  <div className="mt-2 flex items-center gap-2">
                    <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                    <span className="text-xs text-zinc-500">Обычно это занимает менее минуты…</span>
                  </div>
                )}

                {step.key === 'server' && step.active && (
                  <div className="mt-2 flex items-center gap-2">
                    <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                    <span className="text-xs text-zinc-500">Загрузка модели в память…</span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-xl text-sm text-red-400">
            <span className="font-semibold">Ошибка:</span> {error}
          </div>
        )}

        {/* Log viewer */}
        {logs.length > 0 && (
          <div className="mb-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-zinc-500 uppercase tracking-wider font-semibold">Лог</span>
              {elapsedStr && <span className="text-xs text-zinc-600 font-mono">{elapsedStr}</span>}
            </div>
            <div
              ref={logRef}
              className="bg-zinc-950 border border-zinc-800 rounded-xl p-3 max-h-48 overflow-y-auto font-mono text-xs leading-relaxed"
            >
              {logs.map((line, i) => (
                <div
                  key={i}
                  className={`${
                    line.includes('\u2705') ? 'text-emerald-400' :
                    line.includes('\u274C') ? 'text-red-400' :
                    line.includes('\u{1F4E5}') ? 'text-blue-400' :
                    line.includes('\u{1F50D}') || line.includes('\u{1F680}') ? 'text-amber-400' :
                    'text-zinc-500'
                  }`}
                >
                  {line}
                </div>
              ))}
              {isRunning && (
                <div className="text-zinc-600 animate-pulse">{'\u258D'}</div>
              )}
            </div>
          </div>
        )}

        {/* Action: variant picker + launch button */}
        {phase === 'idle' && (
          <div>
            <div className="flex gap-3 items-stretch">
              {/* Variant dropdown */}
              <div ref={dropdownRef} className="relative">
                <button
                  onClick={() => setDropdownOpen((o) => !o)}
                  className="h-full px-4 rounded-xl border border-zinc-700 bg-zinc-900 hover:border-zinc-500 text-left transition-colors cursor-pointer flex items-center gap-3 min-w-[180px]"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-zinc-200 font-medium truncate">{selectedQuant.replace(/^9B-/, '').replace('UD-', '')}{selectedQuant.startsWith('9B-') ? ' (9B)' : ' (35B)'}</div>
                    <div className="text-[11px] text-zinc-500 leading-tight">
                      {selectedSize}
                    </div>
                  </div>
                  <svg className={`w-4 h-4 text-zinc-500 shrink-0 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {dropdownOpen && variants.length > 0 && (
                  <div className="absolute bottom-full left-0 mb-2 w-[340px] max-h-[400px] overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl shadow-black/50 z-50">
                    <div className="px-3 py-2 border-b border-zinc-800">
                      <span className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold">Квантизация модели</span>
                    </div>
                    {[
                      { title: 'Qwen3.5-9B', items: variants.filter((v) => v.quant.startsWith('9B-')) },
                      { title: 'Qwen3.5-35B-A3B', items: variants.filter((v) => !v.quant.startsWith('9B-')) },
                    ].map((g) => g.items.length === 0 ? null : (
                      <div key={g.title}>
                        <div className="px-3 pt-2 pb-1 text-[10px] text-zinc-600 uppercase tracking-wider font-semibold">{g.title}</div>
                        {g.items.map((v) => {
                          const isSel = v.quant === selectedQuant
                          const colorClass = BITS_COLOR[v.bits] ?? 'text-zinc-400'
                          const displayQuant = v.quant.replace(/^9B-/, '').replace('UD-', '')
                          return (
                            <button
                              key={v.quant}
                              disabled={!v.fits}
                              onClick={() => handleSelectVariant(v.quant)}
                              className={`w-full text-left px-3 py-2.5 flex items-center gap-3 transition-colors cursor-pointer ${
                                !v.fits
                                  ? 'opacity-35 cursor-not-allowed'
                                  : isSel
                                    ? 'bg-blue-500/10'
                                    : 'hover:bg-zinc-800'
                              }`}
                            >
                              <div className={`w-7 text-center text-xs font-bold ${colorClass}`}>
                                {v.bits}b
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className={`text-sm font-medium truncate ${v.fits ? 'text-zinc-200' : 'text-zinc-600'}`}>
                                    {displayQuant}
                                  </span>
                                  {v.recommended && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 font-medium shrink-0">
                                      рек.
                                    </span>
                                  )}
                                  {isSel && (
                                    <span className="text-blue-400 shrink-0">{'\u2713'}</span>
                                  )}
                                </div>
                                <div className={`text-[11px] leading-tight mt-0.5 ${v.fits ? 'text-zinc-500' : 'text-zinc-700'}`}>
                                  {formatSize(v.sizeMb)}
                                  {v.fits && <> {'\u00b7'} ctx {formatCtx(v.maxCtx)} {'\u00b7'} {v.mode === 'full_gpu' ? 'GPU' : v.mode === 'hybrid' ? 'GPU+CPU' : 'CPU'}</>}
                                  {!v.fits && <> {'\u00b7'} не хватает памяти</>}
                                </div>
                              </div>
                            </button>
                          )
                        })}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Context selector */}
              <div ref={ctxDropdownRef} className="relative">
                <button
                  onClick={() => setCtxDropdownOpen((o) => !o)}
                  className="h-full px-4 rounded-xl border border-zinc-700 bg-zinc-900 hover:border-zinc-500 text-left transition-colors cursor-pointer flex items-center gap-3 min-w-[100px]"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-zinc-200 font-medium">{displayCtx}</div>
                    <div className="text-[11px] text-zinc-500 leading-tight">контекст</div>
                  </div>
                  <svg className={`w-3.5 h-3.5 text-zinc-500 shrink-0 transition-transform ${ctxDropdownOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {ctxDropdownOpen && (
                  <div className="absolute bottom-full left-0 mb-2 w-[160px] rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl shadow-black/50 z-50">
                    <div className="px-3 py-2 border-b border-zinc-800">
                      <span className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold">Контекст</span>
                    </div>
                    {availableCtxOptions.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => handleSelectCtx(opt.value)}
                        className={`w-full text-left px-3 py-2 text-sm transition-colors cursor-pointer ${
                          selectedCtx === opt.value ? 'bg-blue-500/10 text-blue-400' : 'text-zinc-300 hover:bg-zinc-800'
                        }`}
                      >
                        {opt.label}
                        {selectedCtx === opt.value && <span className="ml-2 text-blue-400">{'\u2713'}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Launch button */}
              <button
                onClick={handleStart}
                className="flex-1 py-4 rounded-xl font-semibold text-base bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white shadow-lg shadow-blue-500/20 hover:shadow-blue-500/30 transition-all cursor-pointer active:scale-[0.98]"
              >
                {'\u{1F680}'} Запустить
              </button>
            </div>
            <button
              onClick={onComplete}
              className="w-full mt-3 py-2.5 text-sm text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
            >
              Пропустить (если всё уже настроено)
            </button>
          </div>
        )}

        {phase === 'done' && (
          <button
            onClick={onComplete}
            className="w-full py-4 rounded-xl font-semibold text-base bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-white shadow-lg shadow-emerald-500/20 transition-all cursor-pointer active:scale-[0.98]"
          >
            {'\u2728'} Начать работу
          </button>
        )}

        {phase === 'error' && (
          <div className="flex gap-3">
            <button
              onClick={handleStart}
              className="flex-1 py-3 rounded-xl font-semibold text-sm bg-blue-600 hover:bg-blue-500 text-white transition-colors cursor-pointer"
            >
              {'\u{1F504}'} Попробовать снова
            </button>
            <button
              onClick={onComplete}
              className="flex-1 py-3 rounded-xl font-semibold text-sm bg-zinc-800 border border-zinc-700 hover:border-zinc-500 text-zinc-300 transition-colors cursor-pointer"
            >
              Пропустить
            </button>
          </div>
        )}

        {isRunning && (
          <div className="text-center text-xs text-zinc-600 mt-4">
            Не закрывай окно. {elapsedStr && `Прошло: ${elapsedStr}`}
          </div>
        )}
      </div>
    </div>
  )
}
