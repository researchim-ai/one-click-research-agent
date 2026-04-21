import { execSync } from 'child_process'
import os from 'os'
import type { GpuInfo, SystemResources, ServerLaunchArgs, BinarySelection, ModelVariant, ModelVariantInfo, ModelFamily, GpuMode } from './types'
import { readGGUFMetadata, deriveArchInfo, defaultArchInfo, type ModelArchInfo } from './gguf'

export function detectGpus(): GpuInfo[] {
  try {
    const out = execSync(
      'nvidia-smi --query-gpu=index,name,memory.total,memory.free --format=csv,noheader,nounits',
      { timeout: 10000, encoding: 'utf-8' },
    )
    return out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [idx, name, total, free] = line.split(',').map((s) => s.trim())
        return {
          index: parseInt(idx),
          name,
          vramTotalMb: parseInt(total),
          vramFreeMb: parseInt(free),
        }
      })
  } catch {
    return []
  }
}

function detectCudaVersion(): string | null {
  try {
    const out = execSync('nvidia-smi', { timeout: 10000, encoding: 'utf-8' })
    const match = out.match(/CUDA Version:\s*(\d+\.\d+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

function detectAmdGpu(): boolean {
  const plat = process.platform
  try {
    if (plat === 'linux') {
      const out = execSync('lspci 2>/dev/null | grep -iE "VGA|3D|Display"', {
        timeout: 5000, encoding: 'utf-8',
      })
      return /amd|radeon|advanced micro/i.test(out)
    }
    if (plat === 'win32') {
      const out = execSync('wmic path win32_videocontroller get name', {
        timeout: 5000, encoding: 'utf-8',
      })
      return /amd|radeon/i.test(out)
    }
  } catch {}
  return false
}

export function detect(): SystemResources {
  const gpus = detectGpus()
  const cpus = os.cpus()
  const totalRam = os.totalmem()
  const freeRam = os.freemem()

  return {
    gpus,
    cpuModel: cpus[0]?.model ?? 'Unknown',
    cpuCores: new Set(cpus.map((_, i) => Math.floor(i / 2))).size || cpus.length,
    cpuThreads: cpus.length,
    ramTotalMb: Math.round(totalRam / (1024 * 1024)),
    ramAvailableMb: Math.round(freeRam / (1024 * 1024)),
    cudaAvailable: gpus.length > 0,
    cudaVersion: detectCudaVersion(),
    hasAmdGpu: detectAmdGpu(),
    totalVramMb: gpus.reduce((s, g) => s + g.vramTotalMb, 0),
    platform: process.platform,
    arch: process.arch,
  }
}

export function applyGpuPreferences(
  res: SystemResources,
  gpuMode: GpuMode = 'single',
  gpuIndex: number | null = 0,
): SystemResources {
  if (gpuMode !== 'single' || res.gpus.length === 0) return res

  const selected = res.gpus.find((gpu) => gpu.index === gpuIndex) ?? res.gpus[0]
  const gpus = selected ? [selected] : []

  return {
    ...res,
    gpus,
    cudaAvailable: gpus.length > 0,
    totalVramMb: gpus.reduce((sum, gpu) => sum + gpu.vramTotalMb, 0),
  }
}

export function pickBinaryVariant(res: SystemResources): BinarySelection {
  const { platform, arch, cudaVersion, hasAmdGpu, gpus } = res
  const hasNvidia = gpus.length > 0

  if (platform === 'darwin') {
    const variant = arch === 'arm64' ? 'macos-arm64' : 'macos-x64'
    return { primary: variant, fallbacks: [], needsCudart: false }
  }

  if (platform === 'win32') {
    if (hasNvidia && cudaVersion) {
      const major = parseFloat(cudaVersion)
      if (major >= 13) {
        return {
          primary: 'win-cuda-13.1-x64',
          fallbacks: ['win-cuda-12.4-x64', 'win-vulkan-x64', 'win-cpu-x64'],
          needsCudart: true,
          cudartAsset: 'cudart-llama-bin-win-cuda-13.1-x64',
        }
      }
      return {
        primary: 'win-cuda-12.4-x64',
        fallbacks: ['win-vulkan-x64', 'win-cpu-x64'],
        needsCudart: true,
        cudartAsset: 'cudart-llama-bin-win-cuda-12.4-x64',
      }
    }
    if (hasAmdGpu) {
      return { primary: 'win-vulkan-x64', fallbacks: ['win-cpu-x64'], needsCudart: false }
    }
    const cpuVariant = arch === 'arm64' ? 'win-cpu-arm64' : 'win-cpu-x64'
    return { primary: cpuVariant, fallbacks: [], needsCudart: false }
  }

  // Linux with GPU: Vulkan works with both NVIDIA and AMD via drivers
  if (hasNvidia || hasAmdGpu) {
    return { primary: 'ubuntu-vulkan-x64', fallbacks: ['ubuntu-x64'], needsCudart: false }
  }

  return { primary: 'ubuntu-x64', fallbacks: [], needsCudart: false }
}

// ---------------------------------------------------------------------------
// Model architecture — read dynamically from GGUF file, with fallback to
// hardcoded defaults for Qwen3.5-35B-A3B when no file is available.
// ---------------------------------------------------------------------------

let cachedArch: ModelArchInfo | null = null

export function loadModelArch(modelPath: string): ModelArchInfo {
  try {
    const meta = readGGUFMetadata(modelPath)
    cachedArch = deriveArchInfo(meta)
    return cachedArch
  } catch {
    return getArch()
  }
}

export function getArch(): ModelArchInfo {
  if (cachedArch) return cachedArch
  return defaultArchInfo()
}

// ---------------------------------------------------------------------------
// Model variant catalog
// ---------------------------------------------------------------------------

const REPO_9B   = 'unsloth/Qwen3.5-9B-GGUF'
const REPO_35B  = 'unsloth/Qwen3.5-35B-A3B-GGUF'
const REPO_36B  = 'unsloth/Qwen3.6-35B-A3B-GGUF'

export const FAMILY_QWEN35_9B  = 'qwen3.5-9b'
export const FAMILY_QWEN35_35B = 'qwen3.5-35b'
export const FAMILY_QWEN36_35B = 'qwen3.6-35b'

export const MODEL_FAMILIES: ModelFamily[] = [
  {
    id: FAMILY_QWEN35_9B,
    label: 'Qwen3.5-9B',
    description: 'Dense 9B — быстрый, помещается в 16 GB VRAM',
    repoId: REPO_9B,
    defaultQuant: '9B-UD-Q4_K_XL',
    filenameTag: '9b',
  },
  {
    id: FAMILY_QWEN35_35B,
    label: 'Qwen3.5-35B-A3B',
    description: 'MoE 35B (A3B) — баланс качества и скорости',
    repoId: REPO_35B,
    defaultQuant: 'UD-Q4_K_XL',
    filenameTag: '3.5-35b',
    recommended: true,
  },
  {
    id: FAMILY_QWEN36_35B,
    label: 'Qwen3.6-35B-A3B',
    description: 'MoE 35B (A3B) — новая ревизия Qwen3.6',
    repoId: REPO_36B,
    defaultQuant: '36-UD-Q4_K_XL',
    filenameTag: '3.6-35b',
  },
]

export function getModelFamily(id: string): ModelFamily | null {
  return MODEL_FAMILIES.find((f) => f.id === id) ?? null
}

export function getModelFamilyForVariant(variant: ModelVariant): ModelFamily | null {
  return getModelFamily(variant.family)
}

export const MODEL_VARIANTS: ModelVariant[] = [
  // --- Qwen3.5-9B (dense, fast, fits on 16 GB) ---
  { family: FAMILY_QWEN35_9B, quant: '9B-UD-IQ2_XXS',  bits: 2, label: '9B  IQ2_XXS — минимальный', sizeMb: 3266,  quality: 1,  repoId: REPO_9B },
  { family: FAMILY_QWEN35_9B, quant: '9B-UD-IQ2_M',    bits: 2, label: '9B  IQ2_M',                 sizeMb: 3738,  quality: 2,  repoId: REPO_9B },
  { family: FAMILY_QWEN35_9B, quant: '9B-UD-IQ3_XXS',  bits: 3, label: '9B  IQ3_XXS',              sizeMb: 4116,  quality: 3,  repoId: REPO_9B },
  { family: FAMILY_QWEN35_9B, quant: '9B-UD-Q2_K_XL',  bits: 2, label: '9B  Q2_K_XL',              sizeMb: 4219,  quality: 3,  repoId: REPO_9B },
  { family: FAMILY_QWEN35_9B, quant: '9B-UD-Q3_K_XL',  bits: 3, label: '9B  Q3_K_XL',              sizeMb: 5171,  quality: 5,  repoId: REPO_9B },
  { family: FAMILY_QWEN35_9B, quant: '9B-UD-Q4_K_XL',  bits: 4, label: '9B  Q4_K_XL — рекоменд.',  sizeMb: 6113,  quality: 7,  repoId: REPO_9B },
  { family: FAMILY_QWEN35_9B, quant: '9B-UD-Q5_K_XL',  bits: 5, label: '9B  Q5_K_XL',              sizeMb: 6902,  quality: 8,  repoId: REPO_9B },
  { family: FAMILY_QWEN35_9B, quant: '9B-UD-Q6_K_XL',  bits: 6, label: '9B  Q6_K_XL — высокое',    sizeMb: 8971,  quality: 9,  repoId: REPO_9B },
  { family: FAMILY_QWEN35_9B, quant: '9B-UD-Q8_K_XL',  bits: 8, label: '9B  Q8_K_XL — максимум',   sizeMb: 11500, quality: 10, repoId: REPO_9B },

  // --- Qwen3.5-35B-A3B (MoE, мощнее, нужно больше RAM) ---
  { family: FAMILY_QWEN35_35B, quant: 'UD-IQ2_XXS',     bits: 2, label: '35B IQ2_XXS — минимальный', sizeMb: 9994,  quality: 11, repoId: REPO_35B },
  { family: FAMILY_QWEN35_35B, quant: 'UD-Q2_K_XL',     bits: 2, label: '35B Q2_K_XL',              sizeMb: 13210, quality: 12, repoId: REPO_35B },
  { family: FAMILY_QWEN35_35B, quant: 'UD-IQ3_XXS',     bits: 3, label: '35B IQ3_XXS',              sizeMb: 14438, quality: 13, repoId: REPO_35B },
  { family: FAMILY_QWEN35_35B, quant: 'UD-IQ3_S',       bits: 3, label: '35B IQ3_S',                sizeMb: 15565, quality: 14, repoId: REPO_35B },
  { family: FAMILY_QWEN35_35B, quant: 'UD-Q3_K_M',      bits: 3, label: '35B Q3_K_M',               sizeMb: 17101, quality: 15, repoId: REPO_35B },
  { family: FAMILY_QWEN35_35B, quant: 'UD-Q3_K_XL',     bits: 3, label: '35B Q3_K_XL',              sizeMb: 17613, quality: 15, repoId: REPO_35B },
  { family: FAMILY_QWEN35_35B, quant: 'UD-Q4_K_M',      bits: 4, label: '35B Q4_K_M — баланс',      sizeMb: 20378, quality: 17, repoId: REPO_35B },
  { family: FAMILY_QWEN35_35B, quant: 'UD-Q4_K_XL',     bits: 4, label: '35B Q4_K_XL — рекоменд.',   sizeMb: 21094, quality: 18, repoId: REPO_35B },
  { family: FAMILY_QWEN35_35B, quant: 'UD-Q5_K_XL',     bits: 5, label: '35B Q5_K_XL — высокое',     sizeMb: 25498, quality: 19, repoId: REPO_35B },
  { family: FAMILY_QWEN35_35B, quant: 'UD-Q6_K_XL',     bits: 6, label: '35B Q6_K_XL',              sizeMb: 31027, quality: 20, repoId: REPO_35B },
  { family: FAMILY_QWEN35_35B, quant: 'UD-Q8_K_XL',     bits: 8, label: '35B Q8_K_XL — максимум',    sizeMb: 39629, quality: 21, repoId: REPO_35B },

  // --- Qwen3.6-35B-A3B (новая ревизия той же MoE архитектуры) ---
  // Sizes are ~identical к соответствующим квантам Qwen3.5-35B-A3B.
  { family: FAMILY_QWEN36_35B, quant: '36-UD-IQ2_XXS',  bits: 2, label: '35B 3.6 IQ2_XXS — минимальный', sizeMb: 9994,  quality: 11, repoId: REPO_36B },
  { family: FAMILY_QWEN36_35B, quant: '36-UD-IQ2_M',    bits: 2, label: '35B 3.6 IQ2_M',                 sizeMb: 11600, quality: 12, repoId: REPO_36B },
  { family: FAMILY_QWEN36_35B, quant: '36-UD-Q2_K_XL',  bits: 2, label: '35B 3.6 Q2_K_XL',              sizeMb: 13210, quality: 12, repoId: REPO_36B },
  { family: FAMILY_QWEN36_35B, quant: '36-UD-IQ3_XXS',  bits: 3, label: '35B 3.6 IQ3_XXS',              sizeMb: 14438, quality: 13, repoId: REPO_36B },
  { family: FAMILY_QWEN36_35B, quant: '36-UD-IQ3_S',    bits: 3, label: '35B 3.6 IQ3_S',                sizeMb: 15565, quality: 14, repoId: REPO_36B },
  { family: FAMILY_QWEN36_35B, quant: '36-UD-Q3_K_M',   bits: 3, label: '35B 3.6 Q3_K_M',               sizeMb: 17101, quality: 15, repoId: REPO_36B },
  { family: FAMILY_QWEN36_35B, quant: '36-UD-Q3_K_XL',  bits: 3, label: '35B 3.6 Q3_K_XL',              sizeMb: 17613, quality: 15, repoId: REPO_36B },
  { family: FAMILY_QWEN36_35B, quant: '36-UD-Q4_K_M',   bits: 4, label: '35B 3.6 Q4_K_M — баланс',      sizeMb: 20378, quality: 17, repoId: REPO_36B },
  { family: FAMILY_QWEN36_35B, quant: '36-UD-Q4_K_XL',  bits: 4, label: '35B 3.6 Q4_K_XL — рекоменд.',   sizeMb: 21094, quality: 18, repoId: REPO_36B },
  { family: FAMILY_QWEN36_35B, quant: '36-UD-Q5_K_XL',  bits: 5, label: '35B 3.6 Q5_K_XL — высокое',     sizeMb: 25498, quality: 19, repoId: REPO_36B },
  { family: FAMILY_QWEN36_35B, quant: '36-UD-Q6_K_XL',  bits: 6, label: '35B 3.6 Q6_K_XL',              sizeMb: 31027, quality: 20, repoId: REPO_36B },
  { family: FAMILY_QWEN36_35B, quant: '36-UD-Q8_K_XL',  bits: 8, label: '35B 3.6 Q8_K_XL — максимум',    sizeMb: 39629, quality: 21, repoId: REPO_36B },
]

// Per-layer VRAM for weight offloading (scales with model file size).
// 35B MoE: Q4_K_XL ≈ 21 GB, ~1.2 GB embeddings+output, 40 layers → ~500 MB/layer
// 9B dense: Q4_K_XL ≈ 6 GB, 36 layers → ~150 MB/layer
const LAYER_REFS_BY_FAMILY: Record<string, { modelMb: number; layerMb: number }> = {
  [FAMILY_QWEN35_9B]:  { modelMb: 6113,  layerMb: 150 },
  [FAMILY_QWEN35_35B]: { modelMb: 21094, layerMb: 500 },
  [FAMILY_QWEN36_35B]: { modelMb: 21094, layerMb: 500 },
}

function modelMemoryMb(variant: ModelVariant): number {
  return Math.round(variant.sizeMb * 1.03)
}

function layerVramMb(variant: ModelVariant): number {
  const ref = LAYER_REFS_BY_FAMILY[variant.family] ?? LAYER_REFS_BY_FAMILY[FAMILY_QWEN35_35B]
  return Math.round(ref.layerMb * (variant.sizeMb / ref.modelMb))
}

export function evaluateVariants(res: SystemResources): ModelVariantInfo[] {
  const freeVram = res.gpus.reduce((s, g) => s + g.vramFreeMb, 0)
  const isLaptop = res.gpus.some((g) => /laptop|mobile/i.test(g.name))
  const totalMem = res.ramTotalMb + freeVram
  const arch = getArch()
  const kvType = { cacheTypeK: 'q8_0', cacheTypeV: 'q8_0' }

  let bestFittingIdx = -1

  const results = MODEL_VARIANTS.map((v) => {
    const memMb = modelMemoryMb(v)
    const layerMb = layerVramMb(v)

    // mmap means ~70% of model pages need to be resident; GPU loads fully
    const minRequired = Math.round(memMb * 0.70) + RAM_OVERHEAD_MB
    const fits = totalMem >= minRequired

    let mode: 'cpu' | 'hybrid' | 'full_gpu' = 'cpu'
    let maxCtx = 4096
    let selectableMaxCtx = 4096
    let fullGpuMaxCtx = 0

    if (fits) {
      fullGpuMaxCtx = selectFullGpuPreset(freeVram, memMb, arch, kvType, SAFE_CALC_OPTIONS)?.ctxSize ?? 0
      const preset = selectPresetForSize(res.ramTotalMb, freeVram, isLaptop, memMb, memMb, layerMb, SAFE_CALC_OPTIONS)
      const selectablePreset = selectPresetForTargetCtx(
        res.ramTotalMb,
        freeVram,
        isLaptop,
        memMb,
        memMb,
        layerMb,
        arch.contextLength,
        SELECTABLE_CALC_OPTIONS,
      )
      maxCtx = preset.ctxSize
      selectableMaxCtx = Math.max(maxCtx, selectablePreset.ctxSize)
      if (fullGpuMaxCtx > 0 && maxCtx <= fullGpuMaxCtx) mode = 'full_gpu'
      else if (freeVram >= 500) mode = 'hybrid'
    }

    return { ...v, fits, maxCtx, selectableMaxCtx, fullGpuMaxCtx, mode, recommended: false }
  })

  // On small systems (RAM ≤ 16 GB and VRAM < 16 GB), prefer 9B-UD-Q4_K_XL
  const smallSystem = res.ramTotalMb <= 17408 && freeVram < 16384
  if (smallSystem) {
    const idx9b = results.findIndex((r) => r.quant === '9B-UD-Q4_K_XL' && r.fits)
    if (idx9b >= 0) { bestFittingIdx = idx9b }
  }

  // Otherwise pick the highest quality that gives >= 16K context
  if (bestFittingIdx === -1) {
    for (let i = results.length - 1; i >= 0; i--) {
      if (results[i].fits && results[i].maxCtx >= 16384) {
        bestFittingIdx = i
        break
      }
    }
  }
  // Fallback: any fitting variant
  if (bestFittingIdx === -1) {
    for (let i = results.length - 1; i >= 0; i--) {
      if (results[i].fits) { bestFittingIdx = i; break }
    }
  }
  if (bestFittingIdx >= 0) results[bestFittingIdx].recommended = true

  return results
}

// ---------------------------------------------------------------------------
// Preset calculation — parameterized by model size and architecture info
// (read from GGUF or fallback defaults)
// ---------------------------------------------------------------------------

const RAM_OVERHEAD_MB = 3000
const KV_SAFETY_FACTOR = 0.80

interface CalcOptions {
  gpuReserveMb: number
  kvSafetyFactor: number
}

const SAFE_CALC_OPTIONS: CalcOptions = {
  gpuReserveMb: 2000,
  kvSafetyFactor: 0.80,
}

const SELECTABLE_CALC_OPTIONS: CalcOptions = {
  gpuReserveMb: 768,
  kvSafetyFactor: 0.92,
}

const CTX_SNAP_TARGETS = [262144, 131072, 65536, 32768, 24576, 16384, 12288, 8192, 6144, 4096]

function kvLayersSplit(gpuLayersCapped: number, arch: ModelArchInfo): { kvOnGpu: number; kvOnCpu: number } {
  const kvOnGpu = Math.round(arch.kvLayers * Math.min(gpuLayersCapped, arch.blockCount) / arch.blockCount)
  return { kvOnGpu, kvOnCpu: arch.kvLayers - kvOnGpu }
}

function calcContextFromMemory(
  vramForKvMb: number,
  kvOnGpu: number,
  ramForKvMb: number,
  kvOnCpu: number,
  kvQuantized: boolean,
  arch: ModelArchInfo,
  kvSafetyFactor: number,
): number {
  const bytesPerLayer = kvQuantized ? arch.kvBytesPerLayerQ8 : arch.kvBytesPerLayerF16
  let maxTokens = Infinity

  if (kvOnGpu > 0) {
    if (vramForKvMb <= 0) return 4096
    const vramBytes = vramForKvMb * 1024 * 1024 * kvSafetyFactor
    maxTokens = Math.min(maxTokens, Math.floor(vramBytes / (kvOnGpu * bytesPerLayer)))
  }

  if (kvOnCpu > 0) {
    if (ramForKvMb <= 0) return 4096
    const ramBytes = ramForKvMb * 1024 * 1024 * kvSafetyFactor
    maxTokens = Math.min(maxTokens, Math.floor(ramBytes / (kvOnCpu * bytesPerLayer)))
  }

  maxTokens = Math.min(maxTokens, arch.contextLength)

  for (const s of CTX_SNAP_TARGETS) {
    if (maxTokens >= s) return s
  }
  return 4096
}

interface Preset {
  nGpuLayers: number
  ctxSize: number
  flashAttn: boolean
  cacheTypeK: string
  cacheTypeV: string
}

function selectFullGpuPreset(
  freeVramMb: number,
  modelVramMb: number,
  arch: ModelArchInfo,
  kvType: { cacheTypeK: string; cacheTypeV: string },
  options: CalcOptions = SAFE_CALC_OPTIONS,
): Preset | null {
  const fullGpuThreshold = modelVramMb + options.gpuReserveMb
  if (freeVramMb < fullGpuThreshold) return null

  const vramForKv = freeVramMb - modelVramMb
  const ctx = calcContextFromMemory(vramForKv, arch.kvLayers, 0, 0, true, arch, options.kvSafetyFactor)
  return { nGpuLayers: 999, ctxSize: ctx, flashAttn: true, ...kvType }
}

function selectPresetForSize(
  ramTotalMb: number,
  freeVramMb: number,
  isLaptop: boolean,
  modelRamMb: number,
  modelVramMb: number,
  perLayerVramMb: number,
  options: CalcOptions = SAFE_CALC_OPTIONS,
): Preset {
  const arch = getArch()
  // q8_0 KV cache: good balance of memory vs speed; recommended for long context (less VRAM/RAM for cache, still accurate)
  const kvType = { cacheTypeK: 'q8_0', cacheTypeV: 'q8_0' }
  // mmap: only hot pages need physical RAM. For MoE only active experts are
  // accessed, but we use 85% to ensure stable performance without page thrashing.
  const perLayerCpuMb = Math.round(perLayerVramMb * 0.85)

  // CPU-only (model loaded via mmap)
  if (freeVramMb < 500) {
    const mmapModelMb = Math.round(modelRamMb * 0.85)
    const ramForModel = ramTotalMb - RAM_OVERHEAD_MB
    if (ramForModel < mmapModelMb) {
      return { nGpuLayers: 0, ctxSize: 4096, flashAttn: false, ...kvType }
    }
    const ramForKv = ramForModel - mmapModelMb
    const ctx = calcContextFromMemory(0, 0, ramForKv, arch.kvLayers, true, arch, options.kvSafetyFactor)
    return { nGpuLayers: 0, ctxSize: ctx, flashAttn: false, ...kvType }
  }

  const fullGpuPreset = selectFullGpuPreset(freeVramMb, modelVramMb, arch, kvType, options)
  if (fullGpuPreset) return fullGpuPreset

  // Hybrid: search for optimal GPU layer count that maximizes context.
  let maxLayersOnGpu = Math.min(arch.blockCount, Math.max(0, Math.floor((freeVramMb - options.gpuReserveMb) / perLayerVramMb)))

  if (isLaptop) {
    maxLayersOnGpu = Math.min(maxLayersOnGpu, Math.max(0, Math.floor((freeVramMb - (options.gpuReserveMb + 1500)) / (perLayerVramMb * 1.2))))
  }

  const layerStep = Math.max(1, Math.floor(arch.blockCount / arch.kvLayers))
  let bestCtx = 0
  let bestNGpu = 0

  for (let nGpu = maxLayersOnGpu; nGpu >= 0; nGpu -= layerStep) {
    const gpuCapped = Math.min(nGpu, arch.blockCount)
    const cpuL = arch.blockCount - gpuCapped
    const { kvOnGpu, kvOnCpu } = kvLayersSplit(gpuCapped, arch)

    const cpuModelRam = cpuL * perLayerCpuMb
    const ramKv = ramTotalMb - RAM_OVERHEAD_MB - cpuModelRam
    const vramKv = freeVramMb - (gpuCapped * perLayerVramMb)

    const ctx = calcContextFromMemory(
      Math.max(0, vramKv), kvOnGpu,
      Math.max(0, ramKv), kvOnCpu,
      true, arch, options.kvSafetyFactor,
    )

    if (ctx > bestCtx || (ctx === bestCtx && nGpu > bestNGpu)) {
      bestCtx = ctx
      bestNGpu = nGpu
    }
  }

  return {
    nGpuLayers: bestNGpu,
    ctxSize: bestCtx,
    flashAttn: bestNGpu > 0,
    ...kvType,
  }
}

function selectPresetForTargetCtx(
  ramTotalMb: number,
  freeVramMb: number,
  isLaptop: boolean,
  modelRamMb: number,
  modelVramMb: number,
  perLayerVramMb: number,
  targetCtx: number,
  options: CalcOptions = SELECTABLE_CALC_OPTIONS,
): Preset {
  const arch = getArch()
  const kvType = { cacheTypeK: 'q8_0', cacheTypeV: 'q8_0' }
  const clampedTarget = Math.min(targetCtx, arch.contextLength)
  const fallback = selectPresetForSize(ramTotalMb, freeVramMb, isLaptop, modelRamMb, modelVramMb, perLayerVramMb, options)

  const fullGpuPreset = selectFullGpuPreset(freeVramMb, modelVramMb, arch, kvType, options)
  if (fullGpuPreset && fullGpuPreset.ctxSize >= clampedTarget) return fullGpuPreset

  const perLayerCpuMb = Math.round(perLayerVramMb * 0.85)
  let maxLayersOnGpu = Math.min(arch.blockCount, Math.max(0, Math.floor((freeVramMb - options.gpuReserveMb) / perLayerVramMb)))
  if (isLaptop) {
    maxLayersOnGpu = Math.min(maxLayersOnGpu, Math.max(0, Math.floor((freeVramMb - (options.gpuReserveMb + 1500)) / (perLayerVramMb * 1.2))))
  }

  const layerStep = Math.max(1, Math.floor(arch.blockCount / arch.kvLayers))
  for (let nGpu = maxLayersOnGpu; nGpu >= 0; nGpu -= layerStep) {
    const gpuCapped = Math.min(nGpu, arch.blockCount)
    const cpuL = arch.blockCount - gpuCapped
    const { kvOnGpu, kvOnCpu } = kvLayersSplit(gpuCapped, arch)

    const cpuModelRam = cpuL * perLayerCpuMb
    const ramKv = ramTotalMb - RAM_OVERHEAD_MB - cpuModelRam
    const vramKv = freeVramMb - (gpuCapped * perLayerVramMb)

    const ctx = calcContextFromMemory(
      Math.max(0, vramKv), kvOnGpu,
      Math.max(0, ramKv), kvOnCpu,
      true, arch, options.kvSafetyFactor,
    )

    if (ctx >= clampedTarget) {
      return {
        nGpuLayers: gpuCapped,
        ctxSize: clampedTarget,
        flashAttn: gpuCapped > 0,
        ...kvType,
      }
    }
  }

  return fallback
}

function selectPreset(ramTotalMb: number, freeVramMb: number, isLaptop: boolean): Preset {
  const defaultVariant =
    MODEL_VARIANTS.find((v) => v.family === FAMILY_QWEN35_35B && v.quant === 'UD-Q4_K_XL')
    ?? MODEL_VARIANTS[0]
  const memMb = modelMemoryMb(defaultVariant)
  const layMb = layerVramMb(defaultVariant)
  return selectPresetForSize(ramTotalMb, freeVramMb, isLaptop, memMb, memMb, layMb)
}

export function computeOptimalArgs(
  res: SystemResources,
  quant?: string,
  userCtxSize?: number | null,
): ServerLaunchArgs {
  const threads = Math.max(1, Math.floor(res.cpuThreads / 2))
  const freeVram = res.gpus.reduce((s, g) => s + g.vramFreeMb, 0)
  const isLaptop = res.gpus.some((g) => /laptop|mobile/i.test(g.name))

  let tensorSplit: string | null = null
  if (res.gpus.length > 1) {
    const total = res.gpus.reduce((s, g) => s + g.vramFreeMb, 0)
    if (total > 0) {
      tensorSplit = res.gpus.map((g) => (g.vramFreeMb / total).toFixed(2)).join(',')
    }
  }

  let preset: Preset
  if (quant) {
    const variant = MODEL_VARIANTS.find((v) => v.quant === quant)
    if (variant) {
      const memMb = modelMemoryMb(variant)
      const layMb = layerVramMb(variant)
      preset = (userCtxSize && userCtxSize > 0)
        ? selectPresetForTargetCtx(res.ramTotalMb, freeVram, isLaptop, memMb, memMb, layMb, userCtxSize, SELECTABLE_CALC_OPTIONS)
        : selectPresetForSize(res.ramTotalMb, freeVram, isLaptop, memMb, memMb, layMb, SAFE_CALC_OPTIONS)
    } else {
      preset = selectPreset(res.ramTotalMb, freeVram, isLaptop)
    }
  } else {
    preset = selectPreset(res.ramTotalMb, freeVram, isLaptop)
  }

  // Respect user's explicit choice when we can fit it by offloading more to CPU/RAM.
  // If the server still can't handle it, queryActualCtxSize() will detect the real n_ctx.
  const ctxSize = (userCtxSize && userCtxSize > 0)
    ? Math.min(userCtxSize, preset.ctxSize)
    : preset.ctxSize

  return {
    nGpuLayers: preset.nGpuLayers,
    ctxSize,
    threads,
    tensorSplit,
    flashAttn: preset.flashAttn,
    cacheTypeK: preset.cacheTypeK,
    cacheTypeV: preset.cacheTypeV,
  }
}
