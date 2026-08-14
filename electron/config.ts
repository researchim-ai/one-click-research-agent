import fs from 'fs'
import path from 'path'
import os from 'os'
import type { GpuMode } from './types'
import type { ResearchPresetId } from '../research-presets'

export type WebSearchProvider = 'disabled' | 'managed-searxng' | 'custom-searxng'
export type AppLanguage = 'ru' | 'en'

export interface CustomTool {
  id: string
  name: string
  description: string
  command: string
  parameters: { name: string; description: string; required: boolean }[]
  enabled: boolean
}

export interface AppConfig {
  lastQuant: string
  ctxSize: number | null
  gpuMode: GpuMode
  gpuIndex: number | null
  selectedPreset: ResearchPresetId
  externalLinksEnabled: boolean
  webSearchProvider: WebSearchProvider
  searxngBaseUrl: string | null
  appLanguage: AppLanguage
  customTools: CustomTool[]
  systemPrompt: string | null
  summarizePrompt: string | null
  maxIterations: number
  temperature: number
  idleTimeoutSec: number
  maxEmptyRetries: number
  /** @deprecated use approvalForFileOps/approvalForCommands */
  approvalRequired?: boolean
  /** Ask before write_file, edit_file, append_file, delete_file, create_directory */
  approvalForFileOps: boolean
  /** Ask before execute_command */
  approvalForCommands: boolean
  /** Ask the user to approve a generated research plan before sub-agents execute it. */
  approvalForPlans: boolean
  /** Automatically call verify_sources before generate_report. */
  autoVerifyBeforeReport: boolean
  /** Supervisor inserts a self-reflect nudge every N iterations (deep-research preset). */
  supervisorAutoReflectEvery: number
  /** Enable embedding server for hybrid recall/search_knowledge. */
  embedEnabled: boolean
  /** Path to GGUF embedding model (defaults to bge-m3 in app data dir). */
  embedModelPath: string | null
  /** Optional polite-pool email for Crossref API. */
  crossrefMailto: string | null
  /** Optional API key for Semantic Scholar. */
  semanticScholarApiKey: string | null
  /**
   * Wall-clock budget (seconds) for the language-agnostic LLM relevance/screening pass over the
   * corpus. Higher = more sources scored by the LLM (better cross-language precision) but slower
   * research runs on a slow GPU; lower = faster but more items fall back to the lexical heuristic.
   */
  semanticScreeningBudgetSec: number
  /**
   * Keep the inference GPU "warm" while llama-server is up: a tiny periodic 1-token completion
   * during idle gaps plus a best-effort persistence-mode enable on start. This prevents the NVIDIA
   * driver from deep power-gating the GPU between the agent's bursty requests, which on some 5xx
   * drivers triggers a GSP timeout ("nvidia-modeset: Error while waiting for GPU progress") that
   * hangs the GPU until reboot. Disable if you prefer minimal idle power draw and don't hit the bug.
   */
  gpuKeepWarm: boolean
}

const DEFAULT_CONFIG: AppConfig = {
  lastQuant: '27-UD-Q4_K_XL',
  ctxSize: null,
  gpuMode: 'single',
  gpuIndex: 0,
  selectedPreset: 'universal',
  externalLinksEnabled: true,
  webSearchProvider: 'disabled',
  searxngBaseUrl: null,
  appLanguage: 'ru',
  customTools: [],
  systemPrompt: null,
  summarizePrompt: null,
  maxIterations: 200,
  temperature: 0.3,
  idleTimeoutSec: 60,
  maxEmptyRetries: 3,
  approvalForFileOps: true,
  approvalForCommands: true,
  approvalForPlans: false,
  autoVerifyBeforeReport: false,
  supervisorAutoReflectEvery: 0,
  embedEnabled: false,
  embedModelPath: null,
  crossrefMailto: null,
  semanticScholarApiKey: null,
  semanticScreeningBudgetSec: 240,
  gpuKeepWarm: true,
}

export function resetToDefaults(): AppConfig {
  const fresh = { ...DEFAULT_CONFIG, customTools: [] }
  const dir = path.dirname(configPath())
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(configPath(), JSON.stringify(fresh, null, 2))
  cached = fresh
  return fresh
}

function configPath(): string {
  return path.join(os.homedir(), '.one-click-agent', 'config.json')
}

let cached: AppConfig | null = null

export function load(): AppConfig {
  if (cached) return cached
  try {
    const raw = fs.readFileSync(configPath(), 'utf-8')
    const parsed = JSON.parse(raw)
    const loaded = { ...DEFAULT_CONFIG, ...parsed }
    if (parsed.webSearchProvider === undefined && parsed.searxngBaseUrl) {
      loaded.webSearchProvider = 'custom-searxng'
    }
    // Migrate old single approvalRequired to the two new flags
    if (parsed.approvalRequired !== undefined && (parsed.approvalForFileOps === undefined || parsed.approvalForCommands === undefined)) {
      loaded.approvalForFileOps = Boolean(parsed.approvalRequired)
      loaded.approvalForCommands = Boolean(parsed.approvalRequired)
    }
    if (parsed.lastQuant === 'UD-Q4_K_XL') loaded.lastQuant = 'UD-Q3_K_XL'
    if (parsed.lastQuant === '9B-UD-Q4_K_XL') loaded.lastQuant = '9B-UD-Q3_K_XL'
    if (parsed.lastQuant === '36-UD-Q4_K_XL') loaded.lastQuant = '36-UD-Q3_K_XL'
    cached = loaded
    return loaded
  } catch {
    cached = { ...DEFAULT_CONFIG }
    return cached!
  }
}

export function save(partial: Partial<AppConfig>): AppConfig {
  const current = load()
  const updated = { ...current, ...partial }
  const dir = path.dirname(configPath())
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(configPath(), JSON.stringify(updated, null, 2))
  cached = updated
  return updated
}

export function get<K extends keyof AppConfig>(key: K): AppConfig[K] {
  return load()[key]
}

/**
 * Replace the in-memory config cache with a known-fresh snapshot WITHOUT touching disk.
 * The agent runs in a long-lived worker thread that caches config on first load and reuses it
 * across runs; a setting changed mid-session (e.g. semanticScreeningBudgetSec) never reached the
 * worker's module-level `cfg.*` reads. main.ts already ships the current config in each run's
 * payload — calling this with that snapshot at run start makes every `cfg.get()`/`cfg.load()` in
 * the worker (semantic budget, mailto, language, …) reflect the user's latest settings.
 */
export function hydrateCache(next: AppConfig): void {
  cached = { ...DEFAULT_CONFIG, ...next }
}

export function set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
  save({ [key]: value })
}
