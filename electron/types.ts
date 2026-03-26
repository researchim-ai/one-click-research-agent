export interface GpuInfo {
  index: number
  name: string
  vramTotalMb: number
  vramFreeMb: number
}

export interface SystemResources {
  gpus: GpuInfo[]
  cpuModel: string
  cpuCores: number
  cpuThreads: number
  ramTotalMb: number
  ramAvailableMb: number
  cudaAvailable: boolean
  cudaVersion: string | null
  hasAmdGpu: boolean
  totalVramMb: number
  platform: NodeJS.Platform
  arch: string
}

export interface BinarySelection {
  primary: string
  fallbacks: string[]
  needsCudart: boolean
  cudartAsset?: string
}

export interface ServerLaunchArgs {
  nGpuLayers: number
  ctxSize: number
  threads: number
  tensorSplit: string | null
  flashAttn: boolean
  cacheTypeK: string
  cacheTypeV: string
}

export interface DownloadProgress {
  downloadedMb: number
  totalMb: number
  percent: number
  status: string
}

export interface AgentEvent {
  type: 'status' | 'thinking' | 'tool_call' | 'tool_result' | 'response' | 'error' | 'command_approval' | 'context_usage' | 'new_turn' | 'tool_streaming' | 'stream_stats'
  content?: string
  name?: string
  args?: Record<string, unknown>
  result?: string
  done?: boolean
  approvalId?: string
  toolStreamPath?: string
  toolStreamContent?: string
  contextUsage?: {
    usedTokens: number
    budgetTokens: number
    maxContextTokens: number
    percent: number
  }
  /** Tokens per second from last completed stream (emitted after each LLM response). */
  tokensPerSecond?: number
}

export interface AppStatus {
  serverRunning: boolean
  modelDownloaded: boolean
  modelPath: string | null
  llamaReady: boolean
  serverHealth: { status: string }
}

export interface FileTreeEntry {
  name: string
  path: string
  isDir: boolean
  children?: FileTreeEntry[]
}

export interface ModelVariant {
  quant: string
  bits: number
  label: string
  sizeMb: number
  quality: number
  repoId?: string
}

export interface ModelVariantInfo extends ModelVariant {
  fits: boolean
  maxCtx: number
  mode: 'cpu' | 'hybrid' | 'full_gpu'
  recommended: boolean
}

export interface ToolInfo {
  name: string
  description: string
  builtin: boolean
  enabled: boolean
  id?: string
  command?: string
  parameters?: { name: string; description: string; required: boolean }[]
}
