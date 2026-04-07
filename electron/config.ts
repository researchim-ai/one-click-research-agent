import fs from 'fs'
import path from 'path'
import os from 'os'
import type { GpuMode } from './types'
import type { ResearchPresetId } from '../research-presets'

export type WebSearchProvider = 'disabled' | 'managed-searxng' | 'custom-searxng'

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
}

const DEFAULT_CONFIG: AppConfig = {
  lastQuant: 'UD-Q4_K_XL',
  ctxSize: null,
  gpuMode: 'single',
  gpuIndex: 0,
  selectedPreset: 'universal',
  externalLinksEnabled: true,
  webSearchProvider: 'disabled',
  searxngBaseUrl: null,
  customTools: [],
  systemPrompt: null,
  summarizePrompt: null,
  maxIterations: 200,
  temperature: 0.3,
  idleTimeoutSec: 60,
  maxEmptyRetries: 3,
  approvalForFileOps: true,
  approvalForCommands: true,
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

export function set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
  save({ [key]: value })
}
