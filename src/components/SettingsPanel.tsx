import { useState, useEffect, useRef, type ReactNode } from 'react'
import type { ModelVariantInfo, ToolInfo, SystemResources, GpuMode, WebSearchStatus } from '../../electron/types'
import type { AppConfig, AppLanguage, CustomTool, WebSearchProvider } from '../../electron/config'
import { DEFAULT_PRESET_ID, RESEARCH_PRESETS, type ResearchPresetId } from '../../research-presets'

interface Props {
  open: boolean
  onClose: () => void
  initialTab?: string
}

type Tab = 'model' | 'agent' | 'tools' | 'research' | 'prompts'

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

function formatSize(mb: number, lang: 'ru' | 'en' = 'ru'): string {
  return (mb / 1024).toFixed(1) + (lang === 'ru' ? ' ГБ' : ' GB')
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
  const [appLanguage, setAppLanguage] = useState<AppLanguage>('ru')
  const [agentDirty, setAgentDirty] = useState(false)

  // Prompts state
  const [sysPrompt, setSysPrompt] = useState('')
  const [sumPrompt, setSumPrompt] = useState('')
  const [defaultSysPrompt, setDefaultSysPrompt] = useState('')
  const [defaultSumPrompt, setDefaultSumPrompt] = useState('')
  const [promptsDirty, setPromptsDirty] = useState(false)

  useEffect(() => {
    if (initialTab) {
      const mapped: Tab =
        initialTab === 'prompts' ? 'prompts'
        : initialTab === 'tools' ? 'tools'
        : initialTab === 'agent' ? 'agent'
        : initialTab === 'research' ? 'research'
        : 'model'
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
      setAppLanguage(c.appLanguage ?? 'ru')
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
        const msg = appLanguage === 'ru'
          ? `Сервер запущен, но контекст уменьшен: ${Math.round(result.actualCtx / 1024)}K вместо ${Math.round(selectedCtx / 1024)}K (не хватает памяти)`
          : `Server started, but context reduced: ${Math.round(result.actualCtx / 1024)}K instead of ${Math.round(selectedCtx / 1024)}K (not enough memory)`
        alert(msg)
      }
      onClose()
    } catch (e: any) {
      alert((appLanguage === 'ru' ? 'Ошибка: ' : 'Error: ') + (e.message ?? e))
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
      setAppLanguage(c.appLanguage ?? 'ru')
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

  const tabs: { key: Tab; label: string }[] = appLanguage === 'ru' ? [
    { key: 'model', label: 'Модель' },
    { key: 'agent', label: 'Агент' },
    { key: 'research', label: 'Research' },
    { key: 'tools', label: 'Инструменты' },
    { key: 'prompts', label: 'Промпты' },
  ] : [
    { key: 'model', label: 'Model' },
    { key: 'agent', label: 'Agent' },
    { key: 'research', label: 'Research' },
    { key: 'tools', label: 'Tools' },
    { key: 'prompts', label: 'Prompts' },
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
          <h2 className="text-base font-semibold text-zinc-100">{appLanguage === 'ru' ? 'Настройки' : 'Settings'}</h2>
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
              appLanguage={appLanguage}
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
              appLanguage={appLanguage}
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
                else if (field === 'appLanguage') setAppLanguage(value as AppLanguage)
                setAgentDirty(true)
              }}
            />
          )}
          {tab === 'tools' && (
            <ToolsTab
              appLanguage={appLanguage}
              tools={tools}
              editingTool={editingTool}
              onEdit={setEditingTool}
              onSave={handleSaveCustomTool}
              onDelete={handleDeleteCustomTool}
              onCancelEdit={() => setEditingTool(null)}
            />
          )}
          {tab === 'research' && (
            <ResearchTab appLanguage={appLanguage} cfg={cfg} onCfgChange={(patch) => setCfg({ ...cfg, ...patch } as AppConfig)} />
          )}
          {tab === 'prompts' && (
            <PromptsTab
              appLanguage={appLanguage}
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
              {appLanguage === 'ru' ? 'Сервер будет перезапущен с новыми настройками' : 'Server will restart with new settings'}
            </span>
            <button
              onClick={handleApplyRestart}
              disabled={saving}
              className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 cursor-pointer transition-colors disabled:opacity-50"
            >
              {saving ? (appLanguage === 'ru' ? 'Перезапуск…' : 'Restarting…') : (appLanguage === 'ru' ? 'Применить и перезапустить' : 'Apply & restart')}
            </button>
          </div>
        )}

        {tab === 'agent' && agentDirty && (
          <div className="border-t border-zinc-800 px-5 py-3 flex items-center gap-3 shrink-0">
            <span className="text-xs text-zinc-500 flex-1">
              {appLanguage === 'ru' ? 'Изменения применяются сразу к следующему сообщению' : 'Changes apply to the next message'}
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
                  appLanguage,
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
              {appLanguage === 'ru' ? 'Сохранить' : 'Save'}
            </button>
          </div>
        )}

        {tab === 'prompts' && promptsDirty && (
          <div className="border-t border-zinc-800 px-5 py-3 flex items-center gap-3 shrink-0">
            <span className="text-xs text-zinc-500 flex-1">
              {appLanguage === 'ru' ? 'Промпты применяются к новым сообщениям' : 'Prompts apply to new messages'}
            </span>
            <button
              onClick={handleResetPrompts}
              disabled={saving}
              className="px-4 py-2 text-sm rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 cursor-pointer transition-colors disabled:opacity-50"
            >
              {appLanguage === 'ru' ? 'Сбросить оба' : 'Reset both'}
            </button>
            <button
              onClick={handleSavePrompts}
              disabled={saving}
              className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 cursor-pointer transition-colors disabled:opacity-50"
            >
              {saving
                ? (appLanguage === 'ru' ? 'Сохранение…' : 'Saving…')
                : (appLanguage === 'ru' ? 'Сохранить промпты' : 'Save prompts')}
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
            {appLanguage === 'ru' ? 'Сбросить все настройки по умолчанию' : 'Reset all settings to defaults'}
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
  appLanguage, variants, availableGpus, hasMultipleGpus,
  selectedQuant, selectedCtx, selectedGpuMode, selectedGpuIndex, maxCtx, selectableMaxCtx,
  onQuantChange, onCtxChange, onGpuModeChange, onGpuIndexChange,
}: {
  appLanguage: AppLanguage
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
          title={appLanguage === 'ru' ? 'GPU и размещение модели' : 'GPU & model placement'}
          description={appLanguage === 'ru' ? 'Выбери, на какой видеокарте запускать llama.cpp и как распределять слои модели.' : 'Choose which GPU to run llama.cpp on and how to distribute model layers.'}
        >
          <label className="block text-sm font-medium text-zinc-300 mb-3">{appLanguage === 'ru' ? 'Режим GPU' : 'GPU mode'}</label>
          <div className="flex gap-2 mb-3">
            <button
              onClick={() => onGpuModeChange('single')}
              className={`px-3 py-2 text-sm rounded-lg border transition-colors cursor-pointer ${
                selectedGpuMode === 'single'
                  ? 'border-blue-500/50 bg-blue-500/10 text-blue-400'
                  : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'
              }`}
            >
              {appLanguage === 'ru' ? 'Одна GPU' : 'Single GPU'}
            </button>
            <button
              onClick={() => onGpuModeChange('split')}
              className={`px-3 py-2 text-sm rounded-lg border transition-colors cursor-pointer ${
                selectedGpuMode === 'split'
                  ? 'border-amber-500/50 bg-amber-500/10 text-amber-400'
                  : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'
              }`}
            >
              {appLanguage === 'ru' ? 'Все GPU (экспериментально)' : 'All GPUs (experimental)'}
            </button>
          </div>
          <p className="text-xs text-zinc-500 mb-3">
            {appLanguage === 'ru'
              ? 'Для систем с несколькими видеокартами безопаснее запускать llama.cpp на одной карте. Multi-GPU может быть нестабилен и приводить к случайным падениям драйвера.'
              : 'For multi-GPU systems, it is safer to run llama.cpp on a single card. Multi-GPU can be unstable and cause random driver crashes.'}
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
                    {appLanguage === 'ru' ? 'Свободно' : 'Free'} {formatSize(gpu.vramFreeMb, appLanguage)} {appLanguage === 'ru' ? 'из' : 'of'} {formatSize(gpu.vramTotalMb, appLanguage)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </SettingsSection>
      )}

      <SettingsSection
        title={appLanguage === 'ru' ? 'Модель и квантизация' : 'Model & quantization'}
        description={appLanguage === 'ru' ? 'Здесь выбирается семейство модели, степень квантования и рекомендуемый режим загрузки.' : 'Select the model family, quantization level, and recommended loading mode.'}
      >
        <label className="block text-sm font-medium text-zinc-300 mb-3">{appLanguage === 'ru' ? 'Квантизация модели' : 'Model quantization'}</label>
        <div className="space-y-1 max-h-[360px] overflow-y-auto rounded-xl border border-zinc-800 p-1">
          {(() => {
            const groups: { title: string; items: typeof variants }[] = [
              { title: appLanguage === 'ru' ? 'Qwen3.5-9B (быстрая, компактная)' : 'Qwen3.5-9B (fast, compact)', items: variants.filter((v) => v.quant.startsWith('9B-')) },
              { title: appLanguage === 'ru' ? 'Qwen3.5-35B-A3B (MoE, мощнее)' : 'Qwen3.5-35B-A3B (MoE, more powerful)', items: variants.filter((v) => !v.quant.startsWith('9B-')) },
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
                              {appLanguage === 'ru' ? 'рек.' : 'rec.'}
                            </span>
                          )}
                        </div>
                        <div className={`text-[11px] mt-0.5 ${v.fits ? 'text-zinc-500' : 'text-zinc-700'}`}>
                          {formatSize(v.sizeMb, appLanguage)}
                          {v.fits && <> · {appLanguage === 'ru' ? 'макс.' : 'max'} ctx {formatCtx(v.maxCtx)} · {v.mode === 'full_gpu' ? 'GPU' : v.mode === 'hybrid' ? 'GPU+CPU' : 'CPU'}</>}
                          {!v.fits && (appLanguage === 'ru' ? ' · не хватает памяти' : ' · not enough memory')}
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
        title={appLanguage === 'ru' ? 'Контекст' : 'Context'}
        description={appLanguage === 'ru'
          ? 'Управление длиной контекста для выбранной квантизации. Цвета помогают отличить чистый GPU от гибридного режима GPU+CPU.'
          : 'Context length management for the selected quantization. Colors distinguish pure GPU from hybrid GPU+CPU mode.'}
      >
        <label className="block text-sm font-medium text-zinc-300 mb-2">{appLanguage === 'ru' ? 'Размер контекста' : 'Context size'}</label>
        <p className="text-xs text-zinc-500 mb-3">
          {appLanguage === 'ru' ? 'Рекомендованный максимум для текущей квантизации:' : 'Recommended max for current quantization:'} {formatCtx(maxCtx)}
        </p>
        {selectableMaxCtx > maxCtx && (
          <p className="text-xs text-zinc-500 mb-3">
            {appLanguage === 'ru' ? 'Доступный максимум с offload в GPU+CPU:' : 'Available max with GPU+CPU offload:'} {formatCtx(selectableMaxCtx)}
          </p>
        )}
        {selectedVariant && selectedVariant.fullGpuMaxCtx > 0 && selectedVariant.fullGpuMaxCtx < selectableMaxCtx && (
          <p className="text-xs text-zinc-500 mb-3">
            {appLanguage === 'ru'
              ? <><span className="text-blue-400">Синий</span> = полностью в GPU, <span className="text-amber-400">янтарный</span> = часть слоев и/или KV уйдет в CPU/RAM.</>
              : <><span className="text-blue-400">Blue</span> = fully in GPU, <span className="text-amber-400">amber</span> = some layers and/or KV will go to CPU/RAM.</>}
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
  maxIterations, temperature, idleTimeoutSec, maxEmptyRetries, approvalForFileOps, approvalForCommands, selectedPreset, externalLinksEnabled, webSearchProvider, searxngBaseUrl, webSearchStatus, appLanguage, onChange,
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
  appLanguage: AppLanguage
  onChange: (field: string, value: number | boolean | ResearchPresetId | WebSearchProvider | AppLanguage | string) => void
}) {
  const activePreset = RESEARCH_PRESETS.find((preset) => preset.id === selectedPreset) ?? RESEARCH_PRESETS[0]
  const t = appLanguage === 'ru' ? {
    agentMode: 'Режим агента',
    agentModeHint: 'По умолчанию работает универсальный research-agent. Пресеты усиливают его под конкретные сценарии.',
    active: 'активен',
    examplesTitle: 'Примеры для текущего режима',
    webSearchTitle: 'Web Search',
    webSearchDesc: 'Настройки общего web search через `SearXNG`: локальный managed backend, внешний instance и текущий статус доступности.',
    uiTitle: 'Поведение интерфейса',
    uiDesc: 'Локальные UI-опции, влияющие на удобство и безопасность взаимодействия с результатами агента.',
    extLinks: 'Кликабельные внешние ссылки',
    extLinksHint: 'Разрешить переход по `http/https` ссылкам из ответов агента и показывать предупреждение перед открытием браузера',
    genTitle: 'Параметры генерации',
    genDesc: 'Ограничения на длину и характер работы агента во время одного запроса.',
    maxIter: 'Макс. итераций агента',
    maxIterHint: 'Сколько шагов агент может сделать за один запрос',
    temp: 'Температура',
    tempHint: 'Креативность модели',
    reliabilityTitle: 'Надежность выполнения',
    reliabilityDesc: 'Таймауты и ретраи на случай пустых ответов или зависания модели.',
    idleTimeout: 'Таймаут бездействия (сек)',
    idleTimeoutHint: 'Сколько ждать ответа модели без данных',
    emptyRetries: 'Ретраи при пустом ответе',
    emptyRetriesHint: 'Сколько раз повторять при пустом ответе',
    safetyTitle: 'Подтверждения и безопасность',
    safetyDesc: 'Что агент может делать сразу, а что должен дополнительно согласовать с пользователем.',
    approvalFiles: 'Подтверждение записи и создания файлов',
    approvalFilesHint: 'Спрашивать разрешение на write_file, edit_file, append_file, delete_file, create_directory',
    approvalCmds: 'Подтверждение выполнения команд',
    approvalCmdsHint: 'Спрашивать разрешение на execute_command (терминал, сборка, тесты и т.д.)',
    backendStatus: 'Статус backend',
    available: 'доступен',
    unavailable: 'недоступен',
    selected: 'выбрано',
    tempLow: '0 (точно)',
    tempHigh: '1.5 (хаотично)',
  } : {
    agentMode: 'Agent mode',
    agentModeHint: 'Default is a universal research agent. Presets enhance it for specific scenarios.',
    active: 'active',
    examplesTitle: 'Examples for current mode',
    webSearchTitle: 'Web Search',
    webSearchDesc: 'Settings for general web search via SearXNG: local managed backend, external instance, and current availability status.',
    uiTitle: 'Interface behavior',
    uiDesc: 'Local UI options affecting convenience and safety when interacting with agent results.',
    extLinks: 'Clickable external links',
    extLinksHint: 'Allow navigation to http/https links from agent responses and show a warning before opening the browser',
    genTitle: 'Generation parameters',
    genDesc: 'Limits on the length and behavior of the agent during a single request.',
    maxIter: 'Max agent iterations',
    maxIterHint: 'How many steps the agent can take per request',
    temp: 'Temperature',
    tempHint: 'Model creativity',
    reliabilityTitle: 'Execution reliability',
    reliabilityDesc: 'Timeouts and retries for empty responses or model hangs.',
    idleTimeout: 'Idle timeout (sec)',
    idleTimeoutHint: 'How long to wait for model response without data',
    emptyRetries: 'Empty response retries',
    emptyRetriesHint: 'How many times to retry on empty response',
    safetyTitle: 'Approvals & safety',
    safetyDesc: 'What the agent can do immediately vs. what requires user approval.',
    approvalFiles: 'Approve file operations',
    approvalFilesHint: 'Ask permission for write_file, edit_file, append_file, delete_file, create_directory',
    approvalCmds: 'Approve command execution',
    approvalCmdsHint: 'Ask permission for execute_command (terminal, builds, tests, etc.)',
    backendStatus: 'Backend status',
    available: 'available',
    unavailable: 'unavailable',
    selected: 'selected',
    tempLow: '0 (precise)',
    tempHigh: '1.5 (chaotic)',
  }

  return (
    <div className="space-y-5">
      <SettingsSection
        title={appLanguage === 'ru' ? 'Язык ответов агента' : 'Agent response language'}
        description={appLanguage === 'ru'
          ? 'На каком языке агент будет отвечать и вести исследование.'
          : 'The language the agent will use to respond and conduct research.'}
      >
        <div className="flex gap-2">
          {([
            { id: 'ru' as const, label: 'Русский', flag: '🇷🇺' },
            { id: 'en' as const, label: 'English', flag: '🇬🇧' },
          ]).map((lang) => {
            const selected = appLanguage === lang.id
            return (
              <button
                key={lang.id}
                type="button"
                onClick={() => onChange('appLanguage', lang.id)}
                className={`flex-1 text-left px-3 py-3 rounded-xl border transition-colors cursor-pointer ${
                  selected
                    ? 'border-blue-500/50 bg-blue-500/10'
                    : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-lg">{lang.flag}</span>
                  <span className="text-sm font-medium text-zinc-200">{lang.label}</span>
                  {selected && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 ml-auto">{appLanguage === 'ru' ? 'активен' : 'active'}</span>}
                </div>
              </button>
            )
          })}
        </div>
      </SettingsSection>

      <SettingsSection
        title={appLanguage === 'ru' ? 'Режим работы агента' : 'Agent mode'}
        description={appLanguage === 'ru'
          ? 'Пресет определяет специализацию агента и подмешивает профильные инструкции в системный промпт.'
          : 'Preset defines the agent specialization and injects domain-specific instructions into the system prompt.'}
      >
        <label className="block text-sm font-medium text-zinc-300 mb-2">{t.agentMode}</label>
        <p className="text-xs text-zinc-500 mb-3">
          {t.agentModeHint}
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
                  {isSelected && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400">{t.active}</span>}
                </div>
                <p className="text-xs text-zinc-500 mt-1">{preset.summary}</p>
              </button>
            )
          })}
        </div>
        <div className="mt-3 px-3 py-3 rounded-xl border border-zinc-800 bg-zinc-900/40">
          <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-2">{t.examplesTitle}</div>
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
        title={t.webSearchTitle}
        description={t.webSearchDesc}
      >
        <div className="text-sm font-medium text-zinc-200">{appLanguage === 'ru' ? 'Web search через SearXNG' : 'Web search via SearXNG'}</div>
        <p className="text-xs text-zinc-500 mt-1 mb-3">
          {appLanguage === 'ru'
            ? 'Можно полностью отключить web search, автоматически поднимать локальный SearXNG через Docker или использовать уже существующий instance.'
            : 'You can disable web search entirely, auto-deploy local SearXNG via Docker, or use an existing instance.'}
        </p>
        <div className="space-y-2">
          {(appLanguage === 'ru' ? [
            { id: 'disabled', label: 'Выключено', desc: 'Tool search_web скрыт и агент не использует общий web search.' },
            { id: 'managed-searxng', label: 'Managed local SearXNG', desc: 'Приложение само поднимет локальный контейнер через Docker при первом поиске.' },
            { id: 'custom-searxng', label: 'Existing SearXNG URL', desc: 'Использовать уже существующий совместимый backend.' },
          ] : [
            { id: 'disabled', label: 'Disabled', desc: 'The search_web tool is hidden and the agent does not use general web search.' },
            { id: 'managed-searxng', label: 'Managed local SearXNG', desc: 'The app will auto-deploy a local Docker container on first search.' },
            { id: 'custom-searxng', label: 'Existing SearXNG URL', desc: 'Use an already existing compatible backend.' },
          ]).map((option) => {
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
                  {selected && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400">{t.selected}</span>}
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
              {appLanguage === 'ru'
                ? 'Используется endpoint вида /search?format=json. Если URL пустой, backend не будет доступен.'
                : 'Uses the /search?format=json endpoint. If URL is empty, the backend will be unavailable.'}
            </div>
          </>
        )}
        <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-950/50 px-3 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs font-medium text-zinc-300">{t.backendStatus}</div>
            <div className={`text-[11px] ${webSearchStatus?.healthy ? 'text-emerald-400' : 'text-zinc-500'}`}>
              {webSearchStatus?.healthy ? t.available : t.unavailable}
            </div>
          </div>
          <div className="text-[11px] text-zinc-500 mt-2">
            {webSearchStatus?.detail ?? (appLanguage === 'ru' ? 'Проверка статуса...' : 'Checking status...')}
          </div>
          <div className="text-[11px] text-zinc-600 mt-2">
            Docker: {webSearchStatus?.dockerAvailable ? (appLanguage === 'ru' ? 'доступен' : 'available') : (appLanguage === 'ru' ? 'не найден' : 'not found')}{webSearchStatus?.effectiveBaseUrl ? ` · URL: ${webSearchStatus.effectiveBaseUrl}` : ''}
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title={t.uiTitle}
        description={t.uiDesc}
      >
        <div className="flex items-center justify-between py-2">
          <div>
            <div className="text-sm text-zinc-300">{t.extLinks}</div>
            <div className="text-[11px] text-zinc-600 mt-0.5">{t.extLinksHint}</div>
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
        title={t.genTitle}
        description={t.genDesc}
      >
        <div className="space-y-5">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-sm text-zinc-300">{t.maxIter}</label>
              <span className="text-sm font-mono text-zinc-400">{maxIterations}</span>
            </div>
            <input
              type="range" min={10} max={500} step={10} value={maxIterations}
              onChange={(e) => onChange('maxIterations', parseInt(e.target.value))}
              className="w-full accent-blue-500"
            />
            <div className="flex justify-between text-[10px] text-zinc-600 mt-0.5">
              <span>10</span><span>{t.maxIterHint}</span><span>500</span>
            </div>
          </div>

          <div className="pt-1 border-t border-zinc-800">
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-sm text-zinc-300">{t.temp}</label>
              <span className="text-sm font-mono text-zinc-400">{temperature.toFixed(2)}</span>
            </div>
            <input
              type="range" min={0} max={1.5} step={0.05} value={temperature}
              onChange={(e) => onChange('temperature', parseFloat(e.target.value))}
              className="w-full accent-blue-500"
            />
            <div className="flex justify-between text-[10px] text-zinc-600 mt-0.5">
              <span>{t.tempLow}</span><span>{t.tempHint}</span><span>{t.tempHigh}</span>
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title={t.reliabilityTitle}
        description={t.reliabilityDesc}
      >
        <div className="space-y-5">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-sm text-zinc-300">{t.idleTimeout}</label>
              <span className="text-sm font-mono text-zinc-400">{idleTimeoutSec}{appLanguage === 'ru' ? 'с' : 's'}</span>
            </div>
            <input
              type="range" min={15} max={300} step={5} value={idleTimeoutSec}
              onChange={(e) => onChange('idleTimeoutSec', parseInt(e.target.value))}
              className="w-full accent-blue-500"
            />
            <div className="flex justify-between text-[10px] text-zinc-600 mt-0.5">
              <span>15{appLanguage === 'ru' ? 'с' : 's'}</span><span>{t.idleTimeoutHint}</span><span>300{appLanguage === 'ru' ? 'с' : 's'}</span>
            </div>
          </div>

          <div className="pt-1 border-t border-zinc-800">
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-sm text-zinc-300">{t.emptyRetries}</label>
              <span className="text-sm font-mono text-zinc-400">{maxEmptyRetries}</span>
            </div>
            <input
              type="range" min={1} max={10} step={1} value={maxEmptyRetries}
              onChange={(e) => onChange('maxEmptyRetries', parseInt(e.target.value))}
              className="w-full accent-blue-500"
            />
            <div className="flex justify-between text-[10px] text-zinc-600 mt-0.5">
              <span>1</span><span>{t.emptyRetriesHint}</span><span>10</span>
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title={t.safetyTitle}
        description={t.safetyDesc}
      >
        <div className="flex items-center justify-between py-2">
          <div>
            <div className="text-sm text-zinc-300">{t.approvalFiles}</div>
            <div className="text-[11px] text-zinc-600 mt-0.5">{t.approvalFilesHint}</div>
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
            <div className="text-sm text-zinc-300">{t.approvalCmds}</div>
            <div className="text-[11px] text-zinc-600 mt-0.5">{t.approvalCmdsHint}</div>
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
  appLanguage, tools, editingTool,
  onEdit, onSave, onDelete, onCancelEdit,
}: {
  appLanguage: AppLanguage
  tools: ToolInfo[]
  editingTool: CustomTool | null
  onEdit: (tool: CustomTool | null) => void
  onSave: (tool: CustomTool) => void
  onDelete: (id: string) => void
  onCancelEdit: () => void
}) {
  const builtins = tools.filter((t) => t.builtin)
  const custom = tools.filter((t) => !t.builtin)
  const L = appLanguage === 'ru'

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
        title={L ? 'Встроенные инструменты' : 'Built-in tools'}
        description={L ? 'Это базовые возможности приложения. Они управляются системой и показываются здесь для справки.' : 'Core application capabilities. Managed by the system and shown here for reference.'}
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
        title={L ? 'Пользовательские инструменты' : 'Custom tools'}
        description={L ? 'Собственные команды, которые агент сможет вызывать как отдельные функции.' : 'Custom commands that the agent can call as separate functions.'}
      >
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-zinc-300">{L ? 'Пользовательские инструменты' : 'Custom tools'}</h3>
          <button
            onClick={() => onEdit(newTool())}
            className="text-xs px-2.5 py-1 rounded-lg bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 cursor-pointer transition-colors"
          >
            {L ? '+ Добавить' : '+ Add'}
          </button>
        </div>

        {custom.length === 0 && !editingTool && (
          <p className="text-xs text-zinc-600 py-4 text-center">
            {L
              ? 'Нет пользовательских инструментов. Добавьте свой первый инструмент — агент сможет его вызывать.'
              : 'No custom tools yet. Add your first tool — the agent will be able to call it.'}
          </p>
        )}

        {custom.map((t) => (
          <div key={t.id} className="px-3 py-2.5 rounded-lg border border-zinc-800 mb-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-mono">{t.name}</span>
                {!t.enabled && <span className="text-[10px] text-zinc-600">{L ? 'отключён' : 'disabled'}</span>}
              </div>
              <div className="flex gap-1">
                <button
                  onClick={() => onEdit({ id: t.id!, name: t.name, description: t.description, command: t.command!, parameters: t.parameters!, enabled: t.enabled })}
                  className="text-[10px] px-2 py-0.5 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 cursor-pointer"
                >
                  {L ? 'ред.' : 'edit'}
                </button>
                <button
                  onClick={() => onDelete(t.id!)}
                  className="text-[10px] px-2 py-0.5 rounded text-red-500/60 hover:text-red-400 hover:bg-red-500/10 cursor-pointer"
                >
                  {L ? 'удал.' : 'del'}
                </button>
              </div>
            </div>
            <p className="text-xs text-zinc-500 mt-1">{t.description}</p>
            {t.command && <p className="text-[10px] text-zinc-600 mt-1 font-mono">{t.command}</p>}
          </div>
        ))}

        {editingTool && (
          <ToolEditor appLanguage={appLanguage} tool={editingTool} onSave={onSave} onCancel={onCancelEdit} />
        )}
      </SettingsSection>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tool editor form
// ---------------------------------------------------------------------------

function ToolEditor({
  appLanguage, tool, onSave, onCancel,
}: {
  appLanguage: AppLanguage
  tool: CustomTool
  onSave: (tool: CustomTool) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(tool.name)
  const [desc, setDesc] = useState(tool.description)
  const [cmd, setCmd] = useState(tool.command)
  const [params, setParams] = useState(tool.parameters)
  const [enabled, setEnabled] = useState(tool.enabled)
  const L = appLanguage === 'ru'

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
        <label className="block text-xs text-zinc-400 mb-1">{L ? 'Имя функции (snake_case)' : 'Function name (snake_case)'}</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="run_tests"
          className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:border-blue-500 outline-none"
        />
      </div>
      <div>
        <label className="block text-xs text-zinc-400 mb-1">{L ? 'Описание (для агента)' : 'Description (for the agent)'}</label>
        <input
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="Run the project test suite"
          className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:border-blue-500 outline-none"
        />
      </div>
      <div>
        <label className="block text-xs text-zinc-400 mb-1">
          {L ? 'Команда' : 'Command'} <span className="text-zinc-600">({L ? 'используйте {{param}} для подстановки параметров' : 'use {{param}} for parameter substitution'})</span>
        </label>
        <input
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          placeholder="npm test -- {{filter}}"
          className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-200 font-mono focus:border-blue-500 outline-none"
        />
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs text-zinc-400">{L ? 'Параметры' : 'Parameters'}</label>
          <button onClick={addParam} className="text-[10px] text-blue-400 hover:text-blue-300 cursor-pointer">
            {L ? '+ параметр' : '+ param'}
          </button>
        </div>
        {params.map((p, i) => (
          <div key={i} className="flex items-center gap-2 mb-1.5">
            <input
              value={p.name}
              onChange={(e) => updateParam(i, 'name', e.target.value)}
              placeholder={L ? 'имя' : 'name'}
              className="flex-1 px-2 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-xs text-zinc-200 outline-none"
            />
            <input
              value={p.description}
              onChange={(e) => updateParam(i, 'description', e.target.value)}
              placeholder={L ? 'описание' : 'description'}
              className="flex-[2] px-2 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-xs text-zinc-200 outline-none"
            />
            <label className="flex items-center gap-1 text-[10px] text-zinc-500 cursor-pointer">
              <input
                type="checkbox"
                checked={p.required}
                onChange={(e) => updateParam(i, 'required', e.target.checked)}
                className="rounded"
              />
              {L ? 'обяз.' : 'req.'}
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
        {L ? 'Включён' : 'Enabled'}
      </label>

      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 cursor-pointer"
        >
          {L ? 'Отмена' : 'Cancel'}
        </button>
        <button
          onClick={() => onSave({ id: tool.id, name: name.trim(), description: desc.trim(), command: cmd.trim(), parameters: params, enabled })}
          disabled={!isValid}
          className="px-4 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
        >
          {L ? 'Сохранить' : 'Save'}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Prompts tab
// ---------------------------------------------------------------------------

function PromptsTab({
  appLanguage, sysPrompt, sumPrompt, defaultSysPrompt, defaultSumPrompt,
  onSysChange, onSumChange, onResetSys, onResetSum,
}: {
  appLanguage: AppLanguage
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
  const L = appLanguage === 'ru'

  return (
    <div className="space-y-6">
      <SettingsSection
        title={L ? 'Системный промпт' : 'System prompt'}
        description={L ? 'Главные инструкции для агента: стиль работы, ограничения, приоритеты и общий характер поведения.' : 'Main instructions for the agent: work style, constraints, priorities, and general behavior.'}
      >
        <div className="flex items-center justify-between mb-2">
          <label className="block text-sm font-medium text-zinc-300">{L ? 'Системный промпт' : 'System prompt'}</label>
          {!sysIsDefault && (
            <button
              onClick={onResetSys}
              className="text-[10px] px-2 py-0.5 rounded text-zinc-500 hover:text-amber-400 hover:bg-amber-500/10 cursor-pointer transition-colors"
            >
              {L ? 'Вернуть по умолчанию' : 'Reset to default'}
            </button>
          )}
        </div>
        <p className="text-[11px] text-zinc-600 mb-2">
          {L ? 'Основные инструкции для агента: стиль работы, правила, поведение' : 'Core instructions for the agent: work style, rules, behavior'}
        </p>
        <textarea
          value={sysPrompt}
          onChange={(e) => onSysChange(e.target.value)}
          rows={14}
          spellCheck={false}
          className="w-full px-3 py-2.5 bg-zinc-900 border border-zinc-700 rounded-xl text-xs text-zinc-300 font-mono leading-relaxed focus:border-blue-500 outline-none resize-y min-h-[120px]"
        />
        {sysIsDefault && (
          <p className="text-[10px] text-zinc-700 mt-1">{L ? 'Используется промпт по умолчанию' : 'Using default prompt'}</p>
        )}
      </SettingsSection>

      <SettingsSection
        title={L ? 'Промпт суммаризации' : 'Summarization prompt'}
        description={L ? 'Используется, когда агенту нужно сжать накопленный контекст и продолжить работу без потери сути.' : 'Used when the agent needs to compress accumulated context and continue without losing key information.'}
      >
        <div className="flex items-center justify-between mb-2">
          <label className="block text-sm font-medium text-zinc-300">{L ? 'Промпт суммаризации' : 'Summarization prompt'}</label>
          {!sumIsDefault && (
            <button
              onClick={onResetSum}
              className="text-[10px] px-2 py-0.5 rounded text-zinc-500 hover:text-amber-400 hover:bg-amber-500/10 cursor-pointer transition-colors"
            >
              {L ? 'Вернуть по умолчанию' : 'Reset to default'}
            </button>
          )}
        </div>
        <p className="text-[11px] text-zinc-600 mb-2">
          {L ? 'Инструкция для сжатия контекста при приближении к лимиту' : 'Instructions for compressing context when approaching the limit'}
        </p>
        <textarea
          value={sumPrompt}
          onChange={(e) => onSumChange(e.target.value)}
          rows={8}
          spellCheck={false}
          className="w-full px-3 py-2.5 bg-zinc-900 border border-zinc-700 rounded-xl text-xs text-zinc-300 font-mono leading-relaxed focus:border-blue-500 outline-none resize-y min-h-[80px]"
        />
        {sumIsDefault && (
          <p className="text-[10px] text-zinc-700 mt-1">{L ? 'Используется промпт по умолчанию' : 'Using default prompt'}</p>
        )}
      </SettingsSection>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Research tab — advanced research-agent knobs + embed server + index + workflow
// ---------------------------------------------------------------------------

function ResearchTab({
  appLanguage, cfg, onCfgChange,
}: {
  appLanguage: AppLanguage
  cfg: AppConfig
  onCfgChange: (patch: Partial<AppConfig>) => void
}) {
  const L = appLanguage === 'ru'
  const [saving, setSaving] = useState(false)
  const [embedState, setEmbedState] = useState<{ isRunning: boolean; modelDownloaded: boolean; modelPath: string | null; defaultModelPath: string; apiUrl: string } | null>(null)
  const [embedBusy, setEmbedBusy] = useState<'download' | 'start' | 'stop' | null>(null)
  const [embedPct, setEmbedPct] = useState<number | null>(null)
  const [embedError, setEmbedError] = useState<string | null>(null)
  const [indexStats, setIndexStats] = useState<{ chunks: number; docs: number; hasVectors: boolean } | null>(null)
  const [indexBusy, setIndexBusy] = useState(false)
  const [indexProgress, setIndexProgress] = useState<{ done: number; total: number } | null>(null)
  const [workspaceForIndex, setWorkspaceForIndex] = useState<string>('')

  const refreshEmbed = async () => {
    try { setEmbedState(await window.api.embedStatus()) } catch {}
  }
  const refreshIndex = async (ws: string) => {
    if (!ws) { setIndexStats(null); return }
    try { setIndexStats(await window.api.knowledgeIndexStats(ws)) } catch {}
  }

  useEffect(() => {
    refreshEmbed()
    const offDl = window.api.onEmbedDownloadProgress((pct) => setEmbedPct(pct))
    const offIdx = window.api.onKnowledgeIndexProgress((p) => setIndexProgress(p))
    // Best-effort get current workspace from the URL hash or cfg — but cfg has no workspace field,
    // so we rely on the status bar: the user will see "Index not available" until they pick a workspace.
    // Use the active session's workspace via a simple probe:
    ;(async () => {
      try {
        const recents = await window.api.getRecentWorkspaces()
        if (recents && recents[0]) {
          setWorkspaceForIndex(recents[0])
          refreshIndex(recents[0])
        }
      } catch {}
    })()
    return () => { offDl(); offIdx() }
  }, [])

  const saveCfg = async (patch: Partial<AppConfig>) => {
    setSaving(true)
    try {
      await window.api.saveConfig(patch)
      onCfgChange(patch)
    } finally { setSaving(false) }
  }

  return (
    <div className="space-y-6">
      {/* Workflow */}
      <SettingsSection
        title={L ? 'Рабочий процесс агента' : 'Agent workflow'}
        description={L ? 'Управление паузами на саморефлексию, автоверификацией источников и human-in-the-loop одобрением планов.' : 'Controls self-reflection pauses, automatic source verification, and human-in-the-loop plan approvals.'}
      >
        <div className="space-y-3">
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={!!cfg.approvalForPlans}
              onChange={(e) => saveCfg({ approvalForPlans: e.target.checked })}
              className="mt-0.5 accent-blue-500"
            />
            <div>
              <div className="text-sm text-zinc-200">{L ? 'Запрашивать подтверждение плана' : 'Require plan approval'}</div>
              <div className="text-[11px] text-zinc-500">{L ? 'Перед тем как агент запустит план исследования, он покажет его пользователю.' : 'Before the agent starts a research plan, it will show it to you for approval.'}</div>
            </div>
          </label>
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={!!cfg.autoVerifyBeforeReport}
              onChange={(e) => saveCfg({ autoVerifyBeforeReport: e.target.checked })}
              className="mt-0.5 accent-blue-500"
            />
            <div>
              <div className="text-sm text-zinc-200">{L ? 'Проверять ссылки перед отчётом' : 'Verify sources before report'}</div>
              <div className="text-[11px] text-zinc-500">{L ? 'Автоматически вызывает verify_sources перед generate_report и помечает мёртвые ссылки.' : 'Automatically runs verify_sources before generate_report and flags dead links.'}</div>
            </div>
          </label>
          <div>
            <div className="text-sm text-zinc-200 mb-1">{L ? 'Саморефлексия supervisor' : 'Supervisor auto-reflection'}</div>
            <div className="text-[11px] text-zinc-500 mb-2">{L ? 'Каждые N итераций агент сам делает паузу и вызывает reflect. 0 = выключено (deep-research всё равно активирует).' : 'Every N iterations the agent pauses and calls reflect. 0 = off (deep-research enables it anyway).'}</div>
            <input
              type="number"
              min={0}
              max={50}
              value={cfg.supervisorAutoReflectEvery ?? 0}
              onChange={(e) => saveCfg({ supervisorAutoReflectEvery: Math.max(0, Math.min(50, Number(e.target.value) || 0)) })}
              className="w-28 px-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:border-blue-500 outline-none"
            />
          </div>
        </div>
      </SettingsSection>

      {/* Academic API hints */}
      <SettingsSection
        title={L ? 'Академические API' : 'Academic APIs'}
        description={L ? 'Опциональные контактные email и ключи для вежливого использования API Crossref и Semantic Scholar.' : 'Optional contact emails / API keys for polite use of Crossref and Semantic Scholar.'}
      >
        <div className="space-y-3">
          <div>
            <label className="text-sm text-zinc-200">Crossref <span className="text-zinc-500 text-[11px]">mailto</span></label>
            <input
              type="email"
              placeholder="you@example.com"
              value={cfg.crossrefMailto ?? ''}
              onChange={(e) => saveCfg({ crossrefMailto: e.target.value })}
              className="mt-1 w-full px-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:border-blue-500 outline-none"
            />
            <p className="text-[11px] text-zinc-500 mt-1">{L ? 'Вежливый пул Crossref даёт более стабильные ответы.' : 'Crossref polite pool gives more stable responses.'}</p>
          </div>
          <div>
            <label className="text-sm text-zinc-200">Semantic Scholar <span className="text-zinc-500 text-[11px]">API key</span></label>
            <input
              type="password"
              placeholder={L ? '(не обязательно)' : '(optional)'}
              value={cfg.semanticScholarApiKey ?? ''}
              onChange={(e) => saveCfg({ semanticScholarApiKey: e.target.value })}
              className="mt-1 w-full px-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:border-blue-500 outline-none"
            />
            <p className="text-[11px] text-zinc-500 mt-1">{L ? 'Без ключа работает публичный rate-limit.' : 'Without a key, the public rate limit applies.'}</p>
          </div>
        </div>
      </SettingsSection>

      {/* Embed server */}
      <SettingsSection
        title={L ? 'Сервер эмбеддингов' : 'Embedding server'}
        description={L ? 'Локальный llama-server с моделью bge-m3 для векторного поиска по собранным исследованиям.' : 'Local llama-server running bge-m3 for vector search over collected research.'}
      >
        <div className="space-y-3">
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={!!cfg.embedEnabled}
              onChange={(e) => saveCfg({ embedEnabled: e.target.checked })}
              className="mt-0.5 accent-blue-500"
            />
            <div>
              <div className="text-sm text-zinc-200">{L ? 'Использовать векторные эмбеддинги' : 'Use vector embeddings'}</div>
              <div className="text-[11px] text-zinc-500">{L ? 'Включает семантический поиск поверх локального BM25 индекса (~540 МБ модель).' : 'Enables semantic search on top of the local BM25 index (~540 MB model).'}</div>
            </div>
          </label>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-[11px] space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-zinc-500">{L ? 'Статус:' : 'Status:'}</span>
              <span className={embedState?.isRunning ? 'text-emerald-400' : 'text-zinc-400'}>
                {embedState?.isRunning ? (L ? 'запущен' : 'running') : (L ? 'остановлен' : 'stopped')}
              </span>
              {embedState?.modelDownloaded ? (
                <span className="ml-2 text-emerald-400">{L ? '✓ модель скачана' : '✓ model downloaded'}</span>
              ) : (
                <span className="ml-2 text-amber-400">{L ? 'модель не скачана' : 'model not downloaded'}</span>
              )}
            </div>
            {embedState?.modelPath && (
              <div className="text-zinc-600 font-mono truncate">{embedState.modelPath}</div>
            )}
            {embedPct !== null && embedBusy === 'download' && (
              <div className="text-zinc-500">{L ? 'Загрузка:' : 'Downloading:'} {embedPct}%</div>
            )}
            {embedError && <div className="text-red-400">{embedError}</div>}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!!embedBusy || embedState?.modelDownloaded}
              onClick={async () => {
                setEmbedBusy('download'); setEmbedError(null); setEmbedPct(0)
                const r = await window.api.embedDownloadModel()
                setEmbedBusy(null); setEmbedPct(null)
                if (!r.ok) setEmbedError(r.error || 'download failed')
                refreshEmbed()
              }}
              className="px-3 py-1.5 text-xs rounded-lg bg-blue-600/90 text-white hover:bg-blue-500 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {L ? 'Скачать bge-m3 (~540МБ)' : 'Download bge-m3 (~540MB)'}
            </button>
            <button
              type="button"
              disabled={!!embedBusy || !embedState?.modelDownloaded || embedState?.isRunning}
              onClick={async () => {
                setEmbedBusy('start'); setEmbedError(null)
                const r = await window.api.embedStart()
                setEmbedBusy(null)
                if (!r.ok) setEmbedError(r.error || 'start failed')
                refreshEmbed()
              }}
              className="px-3 py-1.5 text-xs rounded-lg bg-emerald-600/90 text-white hover:bg-emerald-500 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {L ? 'Запустить' : 'Start'}
            </button>
            <button
              type="button"
              disabled={!!embedBusy || !embedState?.isRunning}
              onClick={async () => {
                setEmbedBusy('stop'); setEmbedError(null)
                await window.api.embedStop()
                setEmbedBusy(null); refreshEmbed()
              }}
              className="px-3 py-1.5 text-xs rounded-lg bg-zinc-700 text-zinc-100 hover:bg-zinc-600 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {L ? 'Остановить' : 'Stop'}
            </button>
          </div>
        </div>
      </SettingsSection>

      {/* Knowledge index */}
      <SettingsSection
        title={L ? 'Индекс знаний' : 'Knowledge index'}
        description={L ? 'Гибридный BM25 + вектор индекс по .research/ и сохранённым находкам текущего workspace.' : 'Hybrid BM25 + vector index over .research/ and saved findings for the current workspace.'}
      >
        <div className="space-y-3">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-[11px]">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-zinc-500">{L ? 'Workspace:' : 'Workspace:'}</span>
              <span className="text-zinc-300 font-mono truncate max-w-[260px]" title={workspaceForIndex || '(none)'}>
                {workspaceForIndex || (L ? '(не выбран)' : '(none)')}
              </span>
            </div>
            {indexStats ? (
              <div className="mt-2 text-zinc-400">
                {L ? 'Чанков:' : 'Chunks:'} <span className="font-mono text-zinc-200">{indexStats.chunks}</span>
                <span className="mx-2">·</span>
                {L ? 'документов:' : 'documents:'} <span className="font-mono text-zinc-200">{indexStats.docs}</span>
                <span className="mx-2">·</span>
                {L ? 'векторы:' : 'vectors:'}{' '}
                <span className={indexStats.hasVectors ? 'text-emerald-400' : 'text-zinc-500'}>
                  {indexStats.hasVectors ? (L ? 'есть' : 'present') : (L ? 'нет' : 'none')}
                </span>
              </div>
            ) : (
              <div className="mt-2 text-zinc-500">{L ? 'Статистика недоступна.' : 'Stats unavailable.'}</div>
            )}
            {indexBusy && indexProgress && (
              <div className="mt-2 text-zinc-500">
                {L ? 'Индексация:' : 'Indexing:'} {indexProgress.done} / {indexProgress.total}
              </div>
            )}
          </div>
          <button
            type="button"
            disabled={indexBusy || !workspaceForIndex}
            onClick={async () => {
              if (!workspaceForIndex) return
              setIndexBusy(true); setIndexProgress(null)
              const r = await window.api.knowledgeIndexRebuild(workspaceForIndex)
              setIndexBusy(false)
              if (!r.ok) alert(r.error || 'rebuild failed')
              refreshIndex(workspaceForIndex)
            }}
            className="px-3 py-1.5 text-xs rounded-lg bg-blue-600/90 text-white hover:bg-blue-500 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {L ? 'Перестроить индекс' : 'Rebuild index'}
          </button>
        </div>
      </SettingsSection>

      {saving && (
        <div className="text-[11px] text-zinc-500">{L ? 'Сохранение…' : 'Saving…'}</div>
      )}
    </div>
  )
}
