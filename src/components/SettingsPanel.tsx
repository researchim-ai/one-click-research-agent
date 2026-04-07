import { useState, useEffect, useRef, type ReactNode } from 'react'
import type { ModelVariantInfo, ToolInfo, SystemResources, GpuMode, WebSearchStatus } from '../../electron/types'
import type { AppConfig, CustomTool, WebSearchProvider } from '../../electron/config'
import { DEFAULT_PRESET_ID, RESEARCH_PRESETS, type ResearchPresetId } from '../../research-presets'

interface Props {
  open: boolean
  onClose: () => void
  initialTab?: string
}

type Tab = 'model' | 'agent' | 'tools' | 'prompts'

const CTX_OPTIONS = [
  { value: 262144, label: '262K' },
  { value: 131072, label: '131K' },
  { value: 65536,  label: '65K' },
  { value: 32768,  label: '32K' },
  { value: 24576,  label: '24K' },
  { value: 16384,  label: '16K' },
  { value: 12288,  label: '12K' },
  { value: 8192,   label: '8K' },
  { value: 4096,   label: '4K' },
]

const BITS_COLOR: Record<number, string> = {
  2: 'text-red-400',
  3: 'text-orange-400',
  4: 'text-yellow-300',
  5: 'text-lime-400',
  6: 'text-emerald-400',
  8: 'text-cyan-400',
}

function formatSize(mb: number): string {
  return (mb / 1024).toFixed(1) + ' ГБ'
}

function formatCtx(tokens: number): string {
  if (tokens >= 1024) return Math.round(tokens / 1024) + 'K'
  return String(tokens)
}

function pickQuantForVariants(variants: ModelVariantInfo[], preferredQuant: string): string {
  const preferred = variants.find((variant) => variant.quant === preferredQuant && variant.fits)
  if (preferred) return preferred.quant
  return variants.find((variant) => variant.recommended)?.quant
    ?? variants.find((variant) => variant.fits)?.quant
    ?? preferredQuant
}

function isFullGpuCtx(optionValue: number, selected?: ModelVariantInfo | null): boolean {
  return optionValue <= (selected?.fullGpuMaxCtx ?? 0)
}

function SettingsSection({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-800 bg-zinc-950/50">
        <div className="text-sm font-medium text-zinc-200">{title}</div>
        {description && <div className="text-[11px] text-zinc-500 mt-1">{description}</div>}
      </div>
      <div className="p-4">{children}</div>
    </section>
  )
}

export function SettingsPanel({ open, onClose, initialTab }: Props) {
  const [tab, setTab] = useState<Tab>('model')
  const [cfg, setCfg] = useState<AppConfig | null>(null)
  const [variants, setVariants] = useState<ModelVariantInfo[]>([])
  const [resources, setResources] = useState<SystemResources | null>(null)
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [selectedQuant, setSelectedQuant] = useState('')
  const [selectedCtx, setSelectedCtx] = useState<number>(32768)
  const [selectedGpuMode, setSelectedGpuMode] = useState<GpuMode>('single')
  const [selectedGpuIndex, setSelectedGpuIndex] = useState<number>(0)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editingTool, setEditingTool] = useState<CustomTool | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // Agent params state
  const [maxIterations, setMaxIterations] = useState(200)
  const [temperature, setTemperature] = useState(0.3)
  const [idleTimeoutSec, setIdleTimeoutSec] = useState(60)
  const [maxEmptyRetries, setMaxEmptyRetries] = useState(3)
  const [approvalForFileOps, setApprovalForFileOps] = useState(true)
  const [approvalForCommands, setApprovalForCommands] = useState(true)
  const [selectedPreset, setSelectedPreset] = useState<ResearchPresetId>(DEFAULT_PRESET_ID)
  const [externalLinksEnabled, setExternalLinksEnabled] = useState(true)
  const [webSearchProvider, setWebSearchProvider] = useState<WebSearchProvider>('disabled')
  const [searxngBaseUrl, setSearxngBaseUrl] = useState('')
  const [webSearchStatus, setWebSearchStatus] = useState<WebSearchStatus | null>(null)
  const [agentDirty, setAgentDirty] = useState(false)

  // Prompts state
  const [sysPrompt, setSysPrompt] = useState('')
  const [sumPrompt, setSumPrompt] = useState('')
  const [defaultSysPrompt, setDefaultSysPrompt] = useState('')
  const [defaultSumPrompt, setDefaultSumPrompt] = useState('')
  const [promptsDirty, setPromptsDirty] = useState(false)

  useEffect(() => {
    if (initialTab) {
      const mapped = initialTab === 'prompts' ? 'prompts' : initialTab === 'tools' ? 'tools' : initialTab === 'agent' ? 'agent' : 'model'
      setTab(mapped)
    }
  }, [initialTab, open])

  useEffect(() => {
    if (!open) return
    Promise.all([
      window.api.getConfig(),
      window.api.detectResources(),
      window.api.getTools(),
      window.api.getPrompts(),
    ]).then(async ([c, r, t, p]) => {
      const gpuMode = c.gpuMode ?? 'single'
      const gpuIndex = c.gpuIndex ?? r.gpus[0]?.index ?? 0
      const v = await window.api.getModelVariants({ gpuMode, gpuIndex })
      setCfg(c)
      setResources(r)
      setVariants(v)
      setTools(t)
      setSelectedGpuMode(gpuMode)
      setSelectedGpuIndex(gpuIndex)
      const quant = pickQuantForVariants(v, c.lastQuant || 'UD-Q4_K_XL')
      setSelectedQuant(quant)
      const variant = v.find((vi: ModelVariantInfo) => vi.quant === quant)
      const max = variant?.selectableMaxCtx ?? variant?.maxCtx ?? 32768
      setSelectedCtx((c.ctxSize && c.ctxSize > 0) ? Math.min(c.ctxSize, max) : max)
      setDirty(false)

      setMaxIterations(c.maxIterations ?? 200)
      setTemperature(c.temperature ?? 0.3)
      setIdleTimeoutSec(c.idleTimeoutSec ?? 60)
      setMaxEmptyRetries(c.maxEmptyRetries ?? 3)
      setApprovalForFileOps(c.approvalForFileOps ?? (c as any).approvalRequired ?? true)
      setApprovalForCommands(c.approvalForCommands ?? (c as any).approvalRequired ?? true)
      setSelectedPreset(c.selectedPreset ?? DEFAULT_PRESET_ID)
      setExternalLinksEnabled(c.externalLinksEnabled ?? true)
      setWebSearchProvider(c.webSearchProvider ?? (c.searxngBaseUrl ? 'custom-searxng' : 'disabled'))
      setSearxngBaseUrl(c.searxngBaseUrl ?? '')
      setWebSearchStatus(await window.api.getWebSearchStatus({
        webSearchProvider: c.webSearchProvider ?? (c.searxngBaseUrl ? 'custom-searxng' : 'disabled'),
        searxngBaseUrl: c.searxngBaseUrl ?? null,
      }))
      setAgentDirty(false)

      setSysPrompt(p.systemPrompt ?? p.defaultSystemPrompt)
      setSumPrompt(p.summarizePrompt ?? p.defaultSummarizePrompt)
      setDefaultSysPrompt(p.defaultSystemPrompt)
      setDefaultSumPrompt(p.defaultSummarizePrompt)
      setPromptsDirty(false)
    }).catch(() => {})
  }, [open])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    window.api.getWebSearchStatus({
      webSearchProvider,
      searxngBaseUrl: searxngBaseUrl.trim() || null,
    }).then(setWebSearchStatus).catch(() => {})
  }, [open, webSearchProvider, searxngBaseUrl])

  if (!open || !cfg) return null

  const currentVariant = variants.find((v) => v.quant === selectedQuant)
  const maxCtx = currentVariant?.maxCtx ?? 262144
  const selectableMaxCtx = currentVariant?.selectableMaxCtx ?? maxCtx
  const availableGpus = resources?.gpus ?? []
  const hasMultipleGpus = availableGpus.length > 1

  const refreshVariantsForGpu = async (
    gpuMode: GpuMode,
    gpuIndex: number,
    preferredQuant = selectedQuant,
    preferredCtx = selectedCtx,
  ) => {
    const nextVariants = await window.api.getModelVariants({ gpuMode, gpuIndex })
    setVariants(nextVariants)
    const nextQuant = pickQuantForVariants(nextVariants, preferredQuant)
    setSelectedQuant(nextQuant)
    const nextVariant = nextVariants.find((variant) => variant.quant === nextQuant)
    const nextMaxCtx = nextVariant?.selectableMaxCtx ?? nextVariant?.maxCtx ?? 32768
    setSelectedCtx(Math.min(preferredCtx, nextMaxCtx))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await window.api.saveConfig({
        lastQuant: selectedQuant,
        ctxSize: selectedCtx,
        gpuMode: selectedGpuMode,
        gpuIndex: selectedGpuIndex,
      })
      await window.api.selectModelVariant(selectedQuant)
      setDirty(false)
    } finally {
      setSaving(false)
    }
  }

  const handleApplyRestart = async () => {
    setSaving(true)
    try {
      await window.api.saveConfig({
        lastQuant: selectedQuant,
        ctxSize: selectedCtx,
        gpuMode: selectedGpuMode,
        gpuIndex: selectedGpuIndex,
      })
      await window.api.selectModelVariant(selectedQuant)
      const result = await window.api.restartServer()
      setDirty(false)
      if (result?.actualCtx && result.actualCtx < selectedCtx) {
        alert(`Сервер запущен, но контекст уменьшен: ${Math.round(result.actualCtx / 1024)}K вместо ${Math.round(selectedCtx / 1024)}K (не хватает памяти)`)
      }
      onClose()
    } catch (e: any) {
      alert('Ошибка: ' + (e.message ?? e))
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteCustomTool = async (toolId: string) => {
    await window.api.deleteCustomTool(toolId)
    const updated = await window.api.getTools()
    setTools(updated)
  }

  const handleSaveCustomTool = async (tool: CustomTool) => {
    await window.api.saveCustomTool(tool)
    const updated = await window.api.getTools()
    setTools(updated)
    setEditingTool(null)
  }

  const handleSavePrompts = async () => {
    setSaving(true)
    try {
      const sysVal = sysPrompt === defaultSysPrompt ? null : sysPrompt
      const sumVal = sumPrompt === defaultSumPrompt ? null : sumPrompt
      await window.api.savePrompts({ systemPrompt: sysVal, summarizePrompt: sumVal })
      setPromptsDirty(false)
    } finally {
      setSaving(false)
    }
  }

  const handleResetPrompts = async () => {
    setSysPrompt(defaultSysPrompt)
    setSumPrompt(defaultSumPrompt)
    await window.api.savePrompts({ systemPrompt: null, summarizePrompt: null })
    setPromptsDirty(false)
  }

  const handleResetAllDefaults = async () => {
    setSaving(true)
    try {
      await window.api.resetAllDefaults()
      const [c, r, t, p] = await Promise.all([
        window.api.getConfig(),
        window.api.detectResources(),
        window.api.getTools(),
        window.api.getPrompts(),
      ])
      const gpuMode = c.gpuMode ?? 'single'
      const gpuIndex = c.gpuIndex ?? r.gpus[0]?.index ?? 0
      const v = await window.api.getModelVariants({ gpuMode, gpuIndex })
      setCfg(c)
      setResources(r)
      setVariants(v)
      setTools(t)
      setSelectedGpuMode(gpuMode)
      setSelectedGpuIndex(gpuIndex)
      const quant = pickQuantForVariants(v, c.lastQuant || 'UD-Q4_K_XL')
      setSelectedQuant(quant)
      const variant = v.find((entry) => entry.quant === quant)
      setSelectedCtx(Math.min(32768, variant?.selectableMaxCtx ?? variant?.maxCtx ?? 32768))
      setSelectedPreset(DEFAULT_PRESET_ID)
      setMaxIterations(c.maxIterations ?? 200)
      setTemperature(c.temperature ?? 0.3)
      setIdleTimeoutSec(c.idleTimeoutSec ?? 60)
      setMaxEmptyRetries(c.maxEmptyRetries ?? 3)
      setApprovalForFileOps(c.approvalForFileOps ?? true)
      setApprovalForCommands(c.approvalForCommands ?? true)
      setExternalLinksEnabled(c.externalLinksEnabled ?? true)
      setWebSearchProvider(c.webSearchProvider ?? (c.searxngBaseUrl ? 'custom-searxng' : 'disabled'))
      setSearxngBaseUrl(c.searxngBaseUrl ?? '')
      setWebSearchStatus(await window.api.getWebSearchStatus({
        webSearchProvider: c.webSearchProvider ?? (c.searxngBaseUrl ? 'custom-searxng' : 'disabled'),
        searxngBaseUrl: c.searxngBaseUrl ?? null,
      }))
      setSysPrompt(p.defaultSystemPrompt)
      setSumPrompt(p.defaultSummarizePrompt)
      setDefaultSysPrompt(p.defaultSystemPrompt)
      setDefaultSumPrompt(p.defaultSummarizePrompt)
      setDirty(false)
      setAgentDirty(false)
      setPromptsDirty(false)
    } finally {
      setSaving(false)
    }
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: 'model', label: 'Модель' },
    { key: 'agent', label: 'Агент' },
    { key: 'tools', label: 'Инструменты' },
    { key: 'prompts', label: 'Промпты' },
  ]

  return (
    <div className="fixed inset-0 z-[200] flex">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div
        ref={panelRef}
        className="relative ml-auto w-full max-w-xl h-full bg-zinc-950 border-l border-zinc-800 flex flex-col shadow-2xl animate-in slide-in-from-right"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800 shrink-0">
          <h2 className="text-base font-semibold text-zinc-100">Настройки</h2>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 cursor-pointer transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-0 border-b border-zinc-800 shrink-0">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-2.5 text-sm font-medium transition-colors cursor-pointer ${
                tab === t.key
                  ? 'text-blue-400 border-b-2 border-blue-400'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {tab === 'model' && (
            <ModelTab
              variants={variants}
              availableGpus={availableGpus}
              hasMultipleGpus={hasMultipleGpus}
              selectedQuant={selectedQuant}
              selectedCtx={selectedCtx}
              selectedGpuMode={selectedGpuMode}
              selectedGpuIndex={selectedGpuIndex}
              maxCtx={maxCtx}
              selectableMaxCtx={selectableMaxCtx}
              onQuantChange={(q) => { setSelectedQuant(q); setDirty(true) }}
              onCtxChange={(c: number) => { setSelectedCtx(c); setDirty(true) }}
              onGpuModeChange={async (gpuMode) => {
                const nextGpuIndex = availableGpus.some((gpu) => gpu.index === selectedGpuIndex)
                  ? selectedGpuIndex
                  : (availableGpus[0]?.index ?? 0)
                setSelectedGpuMode(gpuMode)
                setSelectedGpuIndex(nextGpuIndex)
                await refreshVariantsForGpu(gpuMode, nextGpuIndex)
                setDirty(true)
              }}
              onGpuIndexChange={async (gpuIndex) => {
                setSelectedGpuIndex(gpuIndex)
                await refreshVariantsForGpu(selectedGpuMode, gpuIndex)
                setDirty(true)
              }}
            />
          )}
          {tab === 'agent' && (
            <AgentTab
              maxIterations={maxIterations}
              temperature={temperature}
              idleTimeoutSec={idleTimeoutSec}
              maxEmptyRetries={maxEmptyRetries}
              approvalForFileOps={approvalForFileOps}
              approvalForCommands={approvalForCommands}
              selectedPreset={selectedPreset}
              externalLinksEnabled={externalLinksEnabled}
              webSearchProvider={webSearchProvider}
              searxngBaseUrl={searxngBaseUrl}
              webSearchStatus={webSearchStatus}
              onChange={(field, value) => {
                if (field === 'maxIterations') setMaxIterations(value as number)
                else if (field === 'temperature') setTemperature(value as number)
                else if (field === 'idleTimeoutSec') setIdleTimeoutSec(value as number)
                else if (field === 'maxEmptyRetries') setMaxEmptyRetries(value as number)
                else if (field === 'approvalForFileOps') setApprovalForFileOps(value as boolean)
                else if (field === 'approvalForCommands') setApprovalForCommands(value as boolean)
                else if (field === 'selectedPreset') setSelectedPreset(value as ResearchPresetId)
                else if (field === 'externalLinksEnabled') setExternalLinksEnabled(value as boolean)
                else if (field === 'webSearchProvider') setWebSearchProvider(value as WebSearchProvider)
                else if (field === 'searxngBaseUrl') setSearxngBaseUrl(value as string)
                setAgentDirty(true)
              }}
            />
          )}
          {tab === 'tools' && (
            <ToolsTab
              tools={tools}
              editingTool={editingTool}
              onEdit={setEditingTool}
              onSave={handleSaveCustomTool}
              onDelete={handleDeleteCustomTool}
              onCancelEdit={() => setEditingTool(null)}
            />
          )}
          {tab === 'prompts' && (
            <PromptsTab
              sysPrompt={sysPrompt}
              sumPrompt={sumPrompt}
              defaultSysPrompt={defaultSysPrompt}
              defaultSumPrompt={defaultSumPrompt}
              onSysChange={(v) => { setSysPrompt(v); setPromptsDirty(true) }}
              onSumChange={(v) => { setSumPrompt(v); setPromptsDirty(true) }}
              onResetSys={() => { setSysPrompt(defaultSysPrompt); setPromptsDirty(true) }}
              onResetSum={() => { setSumPrompt(defaultSumPrompt); setPromptsDirty(true) }}
            />
          )}
        </div>

        {/* Footer */}
        {tab === 'model' && dirty && (
          <div className="border-t border-zinc-800 px-5 py-3 flex items-center gap-3 shrink-0">
            <span className="text-xs text-zinc-500 flex-1">
              Сервер будет перезапущен с новыми настройками
            </span>
            <button
              onClick={handleApplyRestart}
              disabled={saving}
              className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 cursor-pointer transition-colors disabled:opacity-50"
            >
              {saving ? 'Перезапуск…' : 'Применить и перезапустить'}
            </button>
          </div>
        )}

        {tab === 'agent' && agentDirty && (
          <div className="border-t border-zinc-800 px-5 py-3 flex items-center gap-3 shrink-0">
            <span className="text-xs text-zinc-500 flex-1">
              Изменения применяются сразу к следующему сообщению
            </span>
            <button
              onClick={async () => {
                await window.api.saveConfig({
                  maxIterations,
                  temperature,
                  idleTimeoutSec,
                  maxEmptyRetries,
                  approvalForFileOps,
                  approvalForCommands,
                  selectedPreset,
                  externalLinksEnabled,
                  webSearchProvider,
                  searxngBaseUrl: searxngBaseUrl.trim() || null,
                })
                setTools(await window.api.getTools())
                setWebSearchStatus(await window.api.getWebSearchStatus({
                  webSearchProvider,
                  searxngBaseUrl: searxngBaseUrl.trim() || null,
                }))
                setAgentDirty(false)
              }}
              className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 cursor-pointer transition-colors"
            >
              Сохранить
            </button>
          </div>
        )}

        {tab === 'prompts' && promptsDirty && (
          <div className="border-t border-zinc-800 px-5 py-3 flex items-center gap-3 shrink-0">
            <span className="text-xs text-zinc-500 flex-1">
              Промпты применяются к новым сообщениям
            </span>
            <button
              onClick={handleResetPrompts}
              disabled={saving}
              className="px-4 py-2 text-sm rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 cursor-pointer transition-colors disabled:opacity-50"
            >
              Сбросить оба
            </button>
            <button
              onClick={handleSavePrompts}
              disabled={saving}
              className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 cursor-pointer transition-colors disabled:opacity-50"
            >
              {saving ? 'Сохранение…' : 'Сохранить промпты'}
            </button>
          </div>
        )}

        {/* Global reset */}
        <div className="border-t border-zinc-800 px-5 py-2 shrink-0">
          <button
            onClick={handleResetAllDefaults}
            disabled={saving}
            className="text-[11px] text-zinc-600 hover:text-red-400 cursor-pointer transition-colors disabled:opacity-50"
          >
            Сбросить все настройки по умолчанию
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Model & Context tab
// ---------------------------------------------------------------------------

function ModelTab({
  variants, availableGpus, hasMultipleGpus,
  selectedQuant, selectedCtx, selectedGpuMode, selectedGpuIndex, maxCtx, selectableMaxCtx,
  onQuantChange, onCtxChange, onGpuModeChange, onGpuIndexChange,
}: {
  variants: ModelVariantInfo[]
  availableGpus: SystemResources['gpus']
  hasMultipleGpus: boolean
  selectedQuant: string
  selectedCtx: number
  selectedGpuMode: GpuMode
  selectedGpuIndex: number
  maxCtx: number
  selectableMaxCtx: number
  onQuantChange: (q: string) => void
  onCtxChange: (c: number) => void
  onGpuModeChange: (mode: GpuMode) => void | Promise<void>
  onGpuIndexChange: (index: number) => void | Promise<void>
}) {
  const selectedVariant = variants.find((variant) => variant.quant === selectedQuant) ?? null

  return (
    <div className="space-y-6">
      {hasMultipleGpus && (
        <SettingsSection
          title="GPU и размещение модели"
          description="Выбери, на какой видеокарте запускать `llama.cpp` и как распределять слои модели."
        >
          <label className="block text-sm font-medium text-zinc-300 mb-3">Режим GPU</label>
          <div className="flex gap-2 mb-3">
            <button
              onClick={() => onGpuModeChange('single')}
              className={`px-3 py-2 text-sm rounded-lg border transition-colors cursor-pointer ${
                selectedGpuMode === 'single'
                  ? 'border-blue-500/50 bg-blue-500/10 text-blue-400'
                  : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'
              }`}
            >
              Одна GPU
            </button>
            <button
              onClick={() => onGpuModeChange('split')}
              className={`px-3 py-2 text-sm rounded-lg border transition-colors cursor-pointer ${
                selectedGpuMode === 'split'
                  ? 'border-amber-500/50 bg-amber-500/10 text-amber-400'
                  : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'
              }`}
            >
              Все GPU (экспериментально)
            </button>
          </div>
          <p className="text-xs text-zinc-500 mb-3">
            Для систем с несколькими видеокартами безопаснее запускать `llama.cpp` на одной карте. Multi-GPU может быть нестабилен и приводить к случайным падениям драйвера.
          </p>
          {selectedGpuMode === 'single' && (
            <div className="space-y-2 rounded-xl border border-zinc-800 p-2">
              {availableGpus.map((gpu) => (
                <button
                  key={gpu.index}
                  onClick={() => onGpuIndexChange(gpu.index)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors cursor-pointer ${
                    selectedGpuIndex === gpu.index
                      ? 'border-blue-500/30 bg-blue-500/10'
                      : 'border-transparent hover:bg-zinc-800/80'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-zinc-200">GPU {gpu.index}: {gpu.name}</span>
                    {selectedGpuIndex === gpu.index && <span className="text-blue-400 text-sm">✓</span>}
                  </div>
                  <div className="text-[11px] text-zinc-500 mt-1">
                    Свободно {formatSize(gpu.vramFreeMb)} из {formatSize(gpu.vramTotalMb)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </SettingsSection>
      )}

      <SettingsSection
        title="Модель и квантизация"
        description="Здесь выбирается семейство модели, степень квантования и рекомендуемый режим загрузки."
      >
        <label className="block text-sm font-medium text-zinc-300 mb-3">Квантизация модели</label>
        <div className="space-y-1 max-h-[360px] overflow-y-auto rounded-xl border border-zinc-800 p-1">
          {(() => {
            const groups: { title: string; items: typeof variants }[] = [
              { title: 'Qwen3.5-9B (быстрая, компактная)', items: variants.filter((v) => v.quant.startsWith('9B-')) },
              { title: 'Qwen3.5-35B-A3B (MoE, мощнее)', items: variants.filter((v) => !v.quant.startsWith('9B-')) },
            ]
            return groups.map((g) => g.items.length === 0 ? null : (
              <div key={g.title}>
                <div className="px-3 pt-2 pb-1 text-[11px] font-semibold text-zinc-500 uppercase tracking-wide">{g.title}</div>
                {g.items.map((v) => {
                  const isSel = v.quant === selectedQuant
                  const colorClass = BITS_COLOR[v.bits] ?? 'text-zinc-400'
                  const displayQuant = v.quant.replace(/^9B-/, '').replace('UD-', '')
                  return (
                    <button
                      key={v.quant}
                      disabled={!v.fits}
                      onClick={() => onQuantChange(v.quant)}
                      className={`w-full text-left px-3 py-2.5 rounded-lg flex items-center gap-3 transition-colors cursor-pointer ${
                        !v.fits
                          ? 'opacity-30 cursor-not-allowed'
                          : isSel
                            ? 'bg-blue-500/15 border border-blue-500/30'
                            : 'hover:bg-zinc-800/80 border border-transparent'
                      }`}
                    >
                      <div className={`w-7 text-center text-xs font-bold ${colorClass}`}>
                        {v.bits}b
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`text-sm font-medium ${v.fits ? 'text-zinc-200' : 'text-zinc-600'}`}>
                            {displayQuant}
                          </span>
                          {v.recommended && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 font-medium">
                              рек.
                            </span>
                          )}
                        </div>
                        <div className={`text-[11px] mt-0.5 ${v.fits ? 'text-zinc-500' : 'text-zinc-700'}`}>
                          {formatSize(v.sizeMb)}
                          {v.fits && <> · макс. ctx {formatCtx(v.maxCtx)} · {v.mode === 'full_gpu' ? 'GPU' : v.mode === 'hybrid' ? 'GPU+CPU' : 'CPU'}</>}
                          {!v.fits && ' · не хватает памяти'}
                        </div>
                      </div>
                      {isSel && <span className="text-blue-400 shrink-0 text-sm">✓</span>}
                    </button>
                  )
                })}
              </div>
            ))
          })()}
        </div>
      </SettingsSection>

      <SettingsSection
        title="Контекст"
        description="Управление длиной контекста для выбранной квантизации. Цвета помогают отличить чистый GPU от гибридного режима GPU+CPU."
      >
        <label className="block text-sm font-medium text-zinc-300 mb-2">Размер контекста</label>
        <p className="text-xs text-zinc-500 mb-3">
          Рекомендованный максимум для текущей квантизации: {formatCtx(maxCtx)}
        </p>
        {selectableMaxCtx > maxCtx && (
          <p className="text-xs text-zinc-500 mb-3">
            Доступный максимум с offload в GPU+CPU: {formatCtx(selectableMaxCtx)}
          </p>
        )}
        {selectedVariant && selectedVariant.fullGpuMaxCtx > 0 && selectedVariant.fullGpuMaxCtx < selectableMaxCtx && (
          <p className="text-xs text-zinc-500 mb-3">
            <span className="text-blue-400">Синий</span> = полностью в GPU, <span className="text-amber-400">янтарный</span> = часть слоев и/или KV уйдет в CPU/RAM.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {CTX_OPTIONS.filter((o) => o.value <= selectableMaxCtx).map((opt) => (
            (() => {
              const fullGpu = isFullGpuCtx(opt.value, selectedVariant)
              const isSelected = selectedCtx === opt.value
              return (
            <button
              key={opt.value}
              onClick={() => onCtxChange(opt.value)}
              className={`px-3 py-1.5 text-sm rounded-lg border transition-colors cursor-pointer ${
                isSelected
                  ? fullGpu
                    ? 'border-blue-500/50 bg-blue-500/10 text-blue-400'
                    : 'border-amber-500/50 bg-amber-500/10 text-amber-400'
                  : fullGpu
                    ? 'border-zinc-700 text-zinc-400 hover:border-zinc-500'
                    : 'border-amber-500/20 text-amber-300 hover:border-amber-500/40'
              }`}
            >
              {opt.label}
              {!fullGpu && <span className="ml-2 text-[10px] opacity-80">GPU+CPU</span>}
            </button>
              )
            })()
          ))}
        </div>
      </SettingsSection>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Agent tab
// ---------------------------------------------------------------------------

function AgentTab({
  maxIterations, temperature, idleTimeoutSec, maxEmptyRetries, approvalForFileOps, approvalForCommands, selectedPreset, externalLinksEnabled, webSearchProvider, searxngBaseUrl, webSearchStatus, onChange,
}: {
  maxIterations: number
  temperature: number
  idleTimeoutSec: number
  maxEmptyRetries: number
  approvalForFileOps: boolean
  approvalForCommands: boolean
  selectedPreset: ResearchPresetId
  externalLinksEnabled: boolean
  webSearchProvider: WebSearchProvider
  searxngBaseUrl: string
  webSearchStatus: WebSearchStatus | null
  onChange: (field: string, value: number | boolean | ResearchPresetId | WebSearchProvider | string) => void
}) {
  const activePreset = RESEARCH_PRESETS.find((preset) => preset.id === selectedPreset) ?? RESEARCH_PRESETS[0]

  return (
    <div className="space-y-5">
      <SettingsSection
        title="Режим работы агента"
        description="Пресет определяет специализацию агента и подмешивает профильные инструкции в системный промпт."
      >
        <label className="block text-sm font-medium text-zinc-300 mb-2">Режим агента</label>
        <p className="text-xs text-zinc-500 mb-3">
          По умолчанию работает универсальный research-agent. Пресеты усиливают его под конкретные сценарии.
        </p>
        <div className="space-y-2">
          {RESEARCH_PRESETS.map((preset) => {
            const isSelected = preset.id === selectedPreset
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => onChange('selectedPreset', preset.id)}
                className={`w-full text-left px-3 py-3 rounded-xl border transition-colors cursor-pointer ${
                  isSelected
                    ? 'border-blue-500/50 bg-blue-500/10'
                    : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-medium text-zinc-200">{preset.label}</div>
                  {isSelected && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400">активен</span>}
                </div>
                <p className="text-xs text-zinc-500 mt-1">{preset.summary}</p>
              </button>
            )
          })}
        </div>
        <div className="mt-3 px-3 py-3 rounded-xl border border-zinc-800 bg-zinc-900/40">
          <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-2">Примеры для текущего режима</div>
          <div className="flex flex-wrap gap-2">
            {activePreset.examples.map((example) => (
              <span key={example} className="px-2 py-1 rounded-lg bg-zinc-800 text-[11px] text-zinc-400">
                {example}
              </span>
            ))}
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Web Search"
        description="Настройки общего web search через `SearXNG`: локальный managed backend, внешний instance и текущий статус доступности."
      >
        <div className="text-sm font-medium text-zinc-200">Web search через SearXNG</div>
        <p className="text-xs text-zinc-500 mt-1 mb-3">
          Можно полностью отключить web search, автоматически поднимать локальный `SearXNG` через Docker или использовать уже существующий instance.
        </p>
        <div className="space-y-2">
          {[
            {
              id: 'disabled',
              label: 'Выключено',
              desc: 'Tool `search_web` скрыт и агент не использует общий web search.',
            },
            {
              id: 'managed-searxng',
              label: 'Managed local SearXNG',
              desc: 'Приложение само поднимет локальный контейнер через Docker при первом поиске.',
            },
            {
              id: 'custom-searxng',
              label: 'Existing SearXNG URL',
              desc: 'Использовать уже существующий совместимый backend.',
            },
          ].map((option) => {
            const selected = webSearchProvider === option.id
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => onChange('webSearchProvider', option.id)}
                className={`w-full text-left px-3 py-3 rounded-xl border transition-colors cursor-pointer ${
                  selected
                    ? 'border-blue-500/50 bg-blue-500/10'
                    : 'border-zinc-800 bg-zinc-950/40 hover:border-zinc-700'
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-medium text-zinc-200">{option.label}</div>
                  {selected && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400">выбрано</span>}
                </div>
                <p className="text-xs text-zinc-500 mt-1">{option.desc}</p>
              </button>
            )
          })}
        </div>
        {webSearchProvider === 'custom-searxng' && (
          <>
            <input
              type="text"
              value={searxngBaseUrl}
              onChange={(e) => onChange('searxngBaseUrl', e.target.value)}
              placeholder="http://127.0.0.1:8080"
              className="w-full mt-3 px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:border-blue-500 outline-none"
            />
            <div className="text-[11px] text-zinc-600 mt-2">
              Используется endpoint вида `/search?format=json`. Если URL пустой, backend не будет доступен.
            </div>
          </>
        )}
        <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-950/50 px-3 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs font-medium text-zinc-300">Статус backend</div>
            <div className={`text-[11px] ${webSearchStatus?.healthy ? 'text-emerald-400' : 'text-zinc-500'}`}>
              {webSearchStatus?.healthy ? 'доступен' : 'недоступен'}
            </div>
          </div>
          <div className="text-[11px] text-zinc-500 mt-2">
            {webSearchStatus?.detail ?? 'Проверка статуса...'}
          </div>
          <div className="text-[11px] text-zinc-600 mt-2">
            Docker: {webSearchStatus?.dockerAvailable ? 'доступен' : 'не найден'}{webSearchStatus?.effectiveBaseUrl ? ` · URL: ${webSearchStatus.effectiveBaseUrl}` : ''}
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Поведение интерфейса"
        description="Локальные UI-опции, влияющие на удобство и безопасность взаимодействия с результатами агента."
      >
        <div className="flex items-center justify-between py-2">
          <div>
            <div className="text-sm text-zinc-300">Кликабельные внешние ссылки</div>
            <div className="text-[11px] text-zinc-600 mt-0.5">Разрешить переход по `http/https` ссылкам из ответов агента и показывать предупреждение перед открытием браузера</div>
          </div>
          <button
            onClick={() => onChange('externalLinksEnabled', !externalLinksEnabled)}
            className={`w-11 h-6 rounded-full transition-colors relative cursor-pointer ${externalLinksEnabled ? 'bg-blue-600' : 'bg-zinc-700'}`}
          >
            <div className={`w-4.5 h-4.5 rounded-full bg-white absolute top-[3px] transition-transform ${externalLinksEnabled ? 'translate-x-[22px]' : 'translate-x-[3px]'}`} />
          </button>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Параметры генерации"
        description="Ограничения на длину и характер работы агента во время одного запроса."
      >
        <div className="space-y-5">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-sm text-zinc-300">Макс. итераций агента</label>
              <span className="text-sm font-mono text-zinc-400">{maxIterations}</span>
            </div>
            <input
              type="range" min={10} max={500} step={10} value={maxIterations}
              onChange={(e) => onChange('maxIterations', parseInt(e.target.value))}
              className="w-full accent-blue-500"
            />
            <div className="flex justify-between text-[10px] text-zinc-600 mt-0.5">
              <span>10</span><span>Сколько шагов агент может сделать за один запрос</span><span>500</span>
            </div>
          </div>

          <div className="pt-1 border-t border-zinc-800">
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-sm text-zinc-300">Температура</label>
              <span className="text-sm font-mono text-zinc-400">{temperature.toFixed(2)}</span>
            </div>
            <input
              type="range" min={0} max={1.5} step={0.05} value={temperature}
              onChange={(e) => onChange('temperature', parseFloat(e.target.value))}
              className="w-full accent-blue-500"
            />
            <div className="flex justify-between text-[10px] text-zinc-600 mt-0.5">
              <span>0 (точно)</span><span>Креативность модели</span><span>1.5 (хаотично)</span>
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Надежность выполнения"
        description="Таймауты и ретраи на случай пустых ответов или зависания модели."
      >
        <div className="space-y-5">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-sm text-zinc-300">Таймаут бездействия (сек)</label>
              <span className="text-sm font-mono text-zinc-400">{idleTimeoutSec}с</span>
            </div>
            <input
              type="range" min={15} max={300} step={5} value={idleTimeoutSec}
              onChange={(e) => onChange('idleTimeoutSec', parseInt(e.target.value))}
              className="w-full accent-blue-500"
            />
            <div className="flex justify-between text-[10px] text-zinc-600 mt-0.5">
              <span>15с</span><span>Сколько ждать ответа модели без данных</span><span>300с</span>
            </div>
          </div>

          <div className="pt-1 border-t border-zinc-800">
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-sm text-zinc-300">Ретраи при пустом ответе</label>
              <span className="text-sm font-mono text-zinc-400">{maxEmptyRetries}</span>
            </div>
            <input
              type="range" min={1} max={10} step={1} value={maxEmptyRetries}
              onChange={(e) => onChange('maxEmptyRetries', parseInt(e.target.value))}
              className="w-full accent-blue-500"
            />
            <div className="flex justify-between text-[10px] text-zinc-600 mt-0.5">
              <span>1</span><span>Сколько раз повторять при пустом ответе</span><span>10</span>
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Подтверждения и безопасность"
        description="Что агент может делать сразу, а что должен дополнительно согласовать с пользователем."
      >
        <div className="flex items-center justify-between py-2">
          <div>
            <div className="text-sm text-zinc-300">Подтверждение записи и создания файлов</div>
            <div className="text-[11px] text-zinc-600 mt-0.5">Спрашивать разрешение на write_file, edit_file, append_file, delete_file, create_directory</div>
          </div>
          <button
            onClick={() => onChange('approvalForFileOps', !approvalForFileOps)}
            className={`w-11 h-6 rounded-full transition-colors relative cursor-pointer ${approvalForFileOps ? 'bg-blue-600' : 'bg-zinc-700'}`}
          >
            <div className={`w-4.5 h-4.5 rounded-full bg-white absolute top-[3px] transition-transform ${approvalForFileOps ? 'translate-x-[22px]' : 'translate-x-[3px]'}`} />
          </button>
        </div>

        <div className="flex items-center justify-between py-2 border-t border-zinc-800">
          <div>
            <div className="text-sm text-zinc-300">Подтверждение выполнения команд</div>
            <div className="text-[11px] text-zinc-600 mt-0.5">Спрашивать разрешение на execute_command (терминал, сборка, тесты и т.д.)</div>
          </div>
          <button
            onClick={() => onChange('approvalForCommands', !approvalForCommands)}
            className={`w-11 h-6 rounded-full transition-colors relative cursor-pointer ${approvalForCommands ? 'bg-blue-600' : 'bg-zinc-700'}`}
          >
            <div className={`w-4.5 h-4.5 rounded-full bg-white absolute top-[3px] transition-transform ${approvalForCommands ? 'translate-x-[22px]' : 'translate-x-[3px]'}`} />
          </button>
        </div>
      </SettingsSection>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tools tab
// ---------------------------------------------------------------------------

function ToolsTab({
  tools, editingTool,
  onEdit, onSave, onDelete, onCancelEdit,
}: {
  tools: ToolInfo[]
  editingTool: CustomTool | null
  onEdit: (tool: CustomTool | null) => void
  onSave: (tool: CustomTool) => void
  onDelete: (id: string) => void
  onCancelEdit: () => void
}) {
  const builtins = tools.filter((t) => t.builtin)
  const custom = tools.filter((t) => !t.builtin)

  const newTool = (): CustomTool => ({
    id: `ct-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    name: '',
    description: '',
    command: '',
    parameters: [],
    enabled: true,
  })

  return (
    <div className="space-y-6">
      <SettingsSection
        title="Встроенные инструменты"
        description="Это базовые возможности приложения. Они управляются системой и показываются здесь для справки."
      >
        <div className="space-y-1">
          {builtins.map((t) => (
            <div key={t.name} className="px-3 py-2 rounded-lg bg-zinc-900/50 border border-zinc-800/50">
              <div className="flex items-center gap-2">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 font-mono">{t.name}</span>
              </div>
              <p className="text-xs text-zinc-500 mt-1 line-clamp-2">{t.description}</p>
            </div>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection
        title="Пользовательские инструменты"
        description="Собственные команды, которые агент сможет вызывать как отдельные функции."
      >
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-zinc-300">Пользовательские инструменты</h3>
          <button
            onClick={() => onEdit(newTool())}
            className="text-xs px-2.5 py-1 rounded-lg bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 cursor-pointer transition-colors"
          >
            + Добавить
          </button>
        </div>

        {custom.length === 0 && !editingTool && (
          <p className="text-xs text-zinc-600 py-4 text-center">
            Нет пользовательских инструментов. Добавьте свой первый инструмент — агент сможет его вызывать.
          </p>
        )}

        {custom.map((t) => (
          <div key={t.id} className="px-3 py-2.5 rounded-lg border border-zinc-800 mb-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-mono">{t.name}</span>
                {!t.enabled && <span className="text-[10px] text-zinc-600">отключён</span>}
              </div>
              <div className="flex gap-1">
                <button
                  onClick={() => onEdit({ id: t.id!, name: t.name, description: t.description, command: t.command!, parameters: t.parameters!, enabled: t.enabled })}
                  className="text-[10px] px-2 py-0.5 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 cursor-pointer"
                >
                  ред.
                </button>
                <button
                  onClick={() => onDelete(t.id!)}
                  className="text-[10px] px-2 py-0.5 rounded text-red-500/60 hover:text-red-400 hover:bg-red-500/10 cursor-pointer"
                >
                  удал.
                </button>
              </div>
            </div>
            <p className="text-xs text-zinc-500 mt-1">{t.description}</p>
            {t.command && <p className="text-[10px] text-zinc-600 mt-1 font-mono">{t.command}</p>}
          </div>
        ))}

        {editingTool && (
          <ToolEditor tool={editingTool} onSave={onSave} onCancel={onCancelEdit} />
        )}
      </SettingsSection>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tool editor form
// ---------------------------------------------------------------------------

function ToolEditor({
  tool, onSave, onCancel,
}: {
  tool: CustomTool
  onSave: (tool: CustomTool) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(tool.name)
  const [desc, setDesc] = useState(tool.description)
  const [cmd, setCmd] = useState(tool.command)
  const [params, setParams] = useState(tool.parameters)
  const [enabled, setEnabled] = useState(tool.enabled)

  const addParam = () => {
    setParams([...params, { name: '', description: '', required: false }])
  }

  const updateParam = (idx: number, field: string, value: any) => {
    const updated = [...params]
    ;(updated[idx] as any)[field] = value
    setParams(updated)
  }

  const removeParam = (idx: number) => {
    setParams(params.filter((_, i) => i !== idx))
  }

  const isValid = name.trim() && desc.trim() && cmd.trim() && /^[a-z_][a-z0-9_]*$/.test(name.trim())

  return (
    <div className="border border-blue-500/30 rounded-xl p-4 bg-blue-500/5 space-y-3 mt-3">
      <div>
        <label className="block text-xs text-zinc-400 mb-1">Имя функции (snake_case)</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="run_tests"
          className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:border-blue-500 outline-none"
        />
      </div>
      <div>
        <label className="block text-xs text-zinc-400 mb-1">Описание (для агента)</label>
        <input
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="Run the project test suite"
          className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:border-blue-500 outline-none"
        />
      </div>
      <div>
        <label className="block text-xs text-zinc-400 mb-1">
          Команда <span className="text-zinc-600">({'используйте {{param}} для подстановки параметров'})</span>
        </label>
        <input
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          placeholder="npm test -- {{filter}}"
          className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-200 font-mono focus:border-blue-500 outline-none"
        />
      </div>

      {/* Parameters */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs text-zinc-400">Параметры</label>
          <button onClick={addParam} className="text-[10px] text-blue-400 hover:text-blue-300 cursor-pointer">
            + параметр
          </button>
        </div>
        {params.map((p, i) => (
          <div key={i} className="flex items-center gap-2 mb-1.5">
            <input
              value={p.name}
              onChange={(e) => updateParam(i, 'name', e.target.value)}
              placeholder="имя"
              className="flex-1 px-2 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-xs text-zinc-200 outline-none"
            />
            <input
              value={p.description}
              onChange={(e) => updateParam(i, 'description', e.target.value)}
              placeholder="описание"
              className="flex-[2] px-2 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-xs text-zinc-200 outline-none"
            />
            <label className="flex items-center gap-1 text-[10px] text-zinc-500 cursor-pointer">
              <input
                type="checkbox"
                checked={p.required}
                onChange={(e) => updateParam(i, 'required', e.target.checked)}
                className="rounded"
              />
              обяз.
            </label>
            <button onClick={() => removeParam(i)} className="text-red-500/60 hover:text-red-400 text-xs cursor-pointer">
              ✕
            </button>
          </div>
        ))}
      </div>

      <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="rounded"
        />
        Включён
      </label>

      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 cursor-pointer"
        >
          Отмена
        </button>
        <button
          onClick={() => onSave({ id: tool.id, name: name.trim(), description: desc.trim(), command: cmd.trim(), parameters: params, enabled })}
          disabled={!isValid}
          className="px-4 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
        >
          Сохранить
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Prompts tab
// ---------------------------------------------------------------------------

function PromptsTab({
  sysPrompt, sumPrompt, defaultSysPrompt, defaultSumPrompt,
  onSysChange, onSumChange, onResetSys, onResetSum,
}: {
  sysPrompt: string
  sumPrompt: string
  defaultSysPrompt: string
  defaultSumPrompt: string
  onSysChange: (v: string) => void
  onSumChange: (v: string) => void
  onResetSys: () => void
  onResetSum: () => void
}) {
  const sysIsDefault = sysPrompt === defaultSysPrompt
  const sumIsDefault = sumPrompt === defaultSumPrompt

  return (
    <div className="space-y-6">
      <SettingsSection
        title="Системный промпт"
        description="Главные инструкции для агента: стиль работы, ограничения, приоритеты и общий характер поведения."
      >
        <div className="flex items-center justify-between mb-2">
          <label className="block text-sm font-medium text-zinc-300">Системный промпт</label>
          {!sysIsDefault && (
            <button
              onClick={onResetSys}
              className="text-[10px] px-2 py-0.5 rounded text-zinc-500 hover:text-amber-400 hover:bg-amber-500/10 cursor-pointer transition-colors"
            >
              Вернуть по умолчанию
            </button>
          )}
        </div>
        <p className="text-[11px] text-zinc-600 mb-2">
          Основные инструкции для агента: стиль работы, правила, поведение
        </p>
        <textarea
          value={sysPrompt}
          onChange={(e) => onSysChange(e.target.value)}
          rows={14}
          spellCheck={false}
          className="w-full px-3 py-2.5 bg-zinc-900 border border-zinc-700 rounded-xl text-xs text-zinc-300 font-mono leading-relaxed focus:border-blue-500 outline-none resize-y min-h-[120px]"
        />
        {sysIsDefault && (
          <p className="text-[10px] text-zinc-700 mt-1">Используется промпт по умолчанию</p>
        )}
      </SettingsSection>

      <SettingsSection
        title="Промпт суммаризации"
        description="Используется, когда агенту нужно сжать накопленный контекст и продолжить работу без потери сути."
      >
        <div className="flex items-center justify-between mb-2">
          <label className="block text-sm font-medium text-zinc-300">Промпт суммаризации</label>
          {!sumIsDefault && (
            <button
              onClick={onResetSum}
              className="text-[10px] px-2 py-0.5 rounded text-zinc-500 hover:text-amber-400 hover:bg-amber-500/10 cursor-pointer transition-colors"
            >
              Вернуть по умолчанию
            </button>
          )}
        </div>
        <p className="text-[11px] text-zinc-600 mb-2">
          Инструкция для сжатия контекста при приближении к лимиту
        </p>
        <textarea
          value={sumPrompt}
          onChange={(e) => onSumChange(e.target.value)}
          rows={8}
          spellCheck={false}
          className="w-full px-3 py-2.5 bg-zinc-900 border border-zinc-700 rounded-xl text-xs text-zinc-300 font-mono leading-relaxed focus:border-blue-500 outline-none resize-y min-h-[80px]"
        />
        {sumIsDefault && (
          <p className="text-[10px] text-zinc-700 mt-1">Используется промпт по умолчанию</p>
        )}
      </SettingsSection>
    </div>
  )
}
