import { execSync, spawn, ChildProcess } from 'child_process'
import { BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import https from 'https'
import { dataDir } from './model-manager'
import * as config from './config'
import { detect, computeOptimalArgs, pickBinaryVariant, applyGpuPreferences } from './resources'
import type { ServerLaunchArgs } from './types'

let lastServerLog: string[] = []
let activeCtxSize = 0
const SERVER_LOG_FILE = path.join(dataDir(), 'server-debug.log')

const LLAMA_HOST = '127.0.0.1'
const LLAMA_PORT = 7863
const GITHUB_RELEASE_API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest'

export function llamaApiUrl(): string {
  return `http://${LLAMA_HOST}:${LLAMA_PORT}`
}

let serverProcess: ChildProcess | null = null

// --- crash / GPU device-loss recovery state ---------------------------------
// True while we are deliberately tearing the server down (stop/restart), so the
// exit handler and the fatal-error watcher don't fight our own kill.
let intentionalStop = false
// Params of the last start() so we can bring the server back up with the same model/ctx.
let lastStartCtx: { modelPath: string; win?: BrowserWindow; quant?: string; userCtxSize?: number | null } | null = null
// Epoch-ms of recent auto-restarts, to cap restart storms when the GPU is truly wedged.
let recentAutoRestarts: number[] = []
let recovering = false
// Fatal, non-recoverable-in-place GPU faults. When llama.cpp prints one of these the device is
// lost/limping and every subsequent decode fails — the only fix is to kill + relaunch the server.
// (Deliberately excludes plain load-time "out of memory" so a too-big model can't restart-loop.)
const FATAL_GPU_RE = /ErrorDeviceLost|device lost|an illegal memory access|CUDA error|ErrorOutOfDeviceMemory/i

function binDir(): string {
  return path.join(dataDir(), 'llama-bin')
}

function variantFile(): string {
  return path.join(binDir(), '.variant')
}

function tagFile(): string {
  return path.join(binDir(), '.release-tag')
}

function getInstalledVariant(): string | null {
  try { return fs.readFileSync(variantFile(), 'utf-8').trim() } catch { return null }
}

function setInstalledVariant(variant: string): void {
  fs.mkdirSync(binDir(), { recursive: true })
  fs.writeFileSync(variantFile(), variant)
}

function backendOf(variant: string | null): 'cuda' | 'vulkan' | 'cpu' {
  const v = (variant || '').toLowerCase()
  if (v.includes('cuda')) return 'cuda'
  if (v.includes('vulkan')) return 'vulkan'
  return 'cpu'
}

/** A CPU-only llama.cpp build (win-cpu-*, ubuntu-x64 without vulkan, etc). */
function isCpuVariant(variant: string | null): boolean {
  return backendOf(variant) === 'cpu'
}

/** Release tag (e.g. "b4321") of the currently installed llama.cpp build, if known. */
export function getInstalledTag(): string | null {
  try { return fs.readFileSync(tagFile(), 'utf-8').trim() || null } catch { return null }
}

function setInstalledTag(tag: string): void {
  fs.mkdirSync(binDir(), { recursive: true })
  fs.writeFileSync(tagFile(), tag)
}

/** Installed variant + release tag + backend info, for display in Settings. */
export function getInstalledInfo(): {
  variant: string | null
  tag: string | null
  installed: boolean
  backend: 'cuda' | 'vulkan' | 'cpu'
  cpuFallbackDespiteGpu: boolean
} {
  const variant = getInstalledVariant()
  const backend = backendOf(variant)
  let gpuPresent = false
  try {
    const res = detect()
    gpuPresent = res.gpus.length > 0 || res.hasAmdGpu
  } catch {}
  return {
    variant,
    tag: getInstalledTag(),
    installed: findServerBin() !== null,
    backend,
    // True when a GPU exists but only the CPU build is installed → generation runs on CPU.
    cpuFallbackDespiteGpu: backend === 'cpu' && gpuPresent,
  }
}

/** Latest available llama.cpp release tag on GitHub (null if the check fails). */
export async function getLatestReleaseTag(): Promise<string | null> {
  try { return (await getLatestRelease()).tag || null } catch { return null }
}

function serverBinName(): string {
  return process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
}

function findServerBin(): string | null {
  const dir = binDir()
  if (!fs.existsSync(dir)) return null

  const binPath = path.join(dir, serverBinName())
  if (fs.existsSync(binPath)) return binPath

  // release archives sometimes nest files in a subfolder
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const nested = path.join(dir, entry.name, serverBinName())
        if (fs.existsSync(nested)) return nested
      }
    }
  } catch {}

  // system-installed fallback
  try {
    const which = execSync(
      process.platform === 'win32' ? 'where llama-server' : 'which llama-server',
      { encoding: 'utf-8', timeout: 5000 },
    ).trim().split('\n')[0]
    if (which) return which
  } catch {}

  return null
}

export function isReady(): boolean {
  return findServerBin() !== null
}

export function isRunning(): boolean {
  if (!serverProcess) return false
  return serverProcess.exitCode === null
}

// ---------------------------------------------------------------------------
// GitHub release helpers
// ---------------------------------------------------------------------------

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const doGet = (u: string) => {
      const mod = u.startsWith('https') ? https : require('http')
      mod.get(u, { headers: { 'User-Agent': 'one-click-agent/0.1', Accept: 'application/json' } }, (res: any) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          doGet(res.headers.location)
          return
        }
        let data = ''
        res.on('data', (c: string) => (data += c))
        res.on('end', () => { try { resolve(JSON.parse(data)) } catch (e) { reject(e) } })
        res.on('error', reject)
      }).on('error', reject)
    }
    doGet(url)
  })
}

interface ReleaseAsset {
  name: string
  browser_download_url: string
  size: number
}

async function getLatestRelease(): Promise<{ tag: string; assets: ReleaseAsset[] }> {
  const body = await fetchJson(GITHUB_RELEASE_API)
  return {
    tag: body.tag_name,
    assets: (body.assets ?? []).map((a: any) => ({
      name: a.name,
      browser_download_url: a.browser_download_url,
      size: a.size,
    })),
  }
}

function matchAsset(assets: ReleaseAsset[], variant: string): ReleaseAsset | null {
  return assets.find((a) => a.name.includes(`-bin-${variant}.`)) ?? null
}

/**
 * Resolve a variant token to a concrete release asset.
 *
 * Most tokens map 1:1 to an asset name ("win-vulkan-x64", "win-cpu-x64", …). CUDA tokens are
 * carried as *major-only* ("win-cuda-12-x64" / "win-cuda-13-x64") because llama.cpp bumps the CUDA
 * minor version across releases (12.4, 13.1 → 13.3, …). A hardcoded minor would silently miss the
 * CUDA build and cascade all the way down to the slow CPU build. So for a major-only CUDA token we
 * pick the newest matching minor asset that actually exists in the release and report back its
 * concrete variant (e.g. "win-cuda-13.3-x64") so cudart download + .variant stay in sync.
 */
function resolveAsset(assets: ReleaseAsset[], variant: string): { asset: ReleaseAsset; variant: string } | null {
  const exact = matchAsset(assets, variant)
  if (exact) return { asset: exact, variant }

  const major = variant.match(/^win-cuda-(\d+)-x64$/)
  if (major) {
    const re = new RegExp(`-bin-(win-cuda-${major[1]}\\.(\\d+)-x64)\\.`)
    let best: { asset: ReleaseAsset; variant: string; minor: number } | null = null
    for (const a of assets) {
      const m = a.name.match(re)
      if (m) {
        const minor = parseInt(m[2], 10)
        if (!best || minor > best.minor) best = { asset: a, variant: m[1], minor }
      }
    }
    if (best) return { asset: best.asset, variant: best.variant }
  }
  return null
}

function matchCudartAsset(assets: ReleaseAsset[], name: string): ReleaseAsset | null {
  return assets.find((a) => a.name.startsWith(name)) ?? null
}

// ---------------------------------------------------------------------------
// Download with progress
// ---------------------------------------------------------------------------

function downloadFile(
  url: string, dest: string, win: BrowserWindow, label: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tmp = dest + '.part'
    const doGet = (u: string) => {
      https.get(u, { headers: { 'User-Agent': 'one-click-agent/0.1' } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          doGet(res.headers.location)
          return
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} при скачивании ${label}`))
          return
        }
        const total = parseInt(res.headers['content-length'] ?? '0', 10)
        const totalMb = Math.round(total / (1024 * 1024))
        let downloaded = 0
        let lastEmit = 0

        const file = fs.createWriteStream(tmp)
        res.pipe(file)
        res.on('data', (chunk: Buffer) => {
          downloaded += chunk.length
          const now = Date.now()
          if (now - lastEmit > 400) {
            const dm = Math.round(downloaded / (1024 * 1024))
            const pct = total > 0 ? (downloaded / total) * 100 : 0
            emitBuild(win, `${label}: ${dm}/${totalMb} МБ (${pct.toFixed(1)}%)`)
            lastEmit = now
          }
        })
        file.on('finish', () => {
          file.close()
          fs.renameSync(tmp, dest)
          resolve()
        })
        res.on('error', (e) => { try { fs.unlinkSync(tmp) } catch {} reject(e) })
        file.on('error', (e) => { try { fs.unlinkSync(tmp) } catch {} reject(e) })
      }).on('error', reject)
    }
    doGet(url)
  })
}

// ---------------------------------------------------------------------------
// Extract archive
// ---------------------------------------------------------------------------

function extractArchive(archivePath: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true })
  if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
    execSync(`tar xzf "${archivePath}" -C "${destDir}"`, { timeout: 120000 })
  } else if (archivePath.endsWith('.zip')) {
    if (process.platform === 'win32') {
      execSync(
        `powershell -NoProfile -Command "Expand-Archive -Force -Path '${archivePath}' -DestinationPath '${destDir}'"`,
        { timeout: 120000 },
      )
    } else {
      execSync(`unzip -o "${archivePath}" -d "${destDir}"`, { timeout: 120000 })
    }
  }
}

// ---------------------------------------------------------------------------
// Verify binary works
// ---------------------------------------------------------------------------

function verifyBinary(binPath: string): boolean {
  try {
    execSync(`"${binPath}" --version`, { timeout: 10000, encoding: 'utf-8' })
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// IPC emit
// ---------------------------------------------------------------------------

function emitBuild(win: BrowserWindow, msg: string) {
  // Progress can arrive from async streams after the user closes the window; guard against a
  // destroyed BrowserWindow/webContents so a late send never crashes the main process.
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  try { win.webContents.send('build-status', msg) } catch {}
}

// ---------------------------------------------------------------------------
// ensureBinary: download pre-built binary from GitHub Releases
// ---------------------------------------------------------------------------

export async function ensureBinary(win: BrowserWindow): Promise<string> {
  const existing = findServerBin()
  const installedVariant = getInstalledVariant()
  if (existing && installedVariant) {
    emitBuild(win, `llama-server уже установлен (${installedVariant}${getInstalledTag() ? ` ${getInstalledTag()}` : ''})`)
    return existing
  }
  return downloadAndInstallLatest(win)
}

/**
 * Download the LATEST llama.cpp release and install it, overwriting any existing binary.
 * Used both for first-time install (ensureBinary) and for the explicit "update" action.
 * The old binary is only overwritten as the new archive extracts, so a failed download
 * leaves the previous working build in place.
 */
async function downloadAndInstallLatest(win: BrowserWindow): Promise<string> {
  const res = detect()
  const selection = pickBinaryVariant(res)

  emitBuild(win, `Система: ${res.platform}/${res.arch}` +
    (res.cudaVersion ? `, CUDA ${res.cudaVersion}` : '') +
    (res.hasAmdGpu ? ', AMD GPU' : '') +
    (res.gpus.length > 0 ? `, ${res.gpus.map((g) => g.name).join(', ')}` : ', без GPU'))

  emitBuild(win, 'Запрос последнего релиза llama.cpp…')
  const release = await getLatestRelease()
  emitBuild(win, `Релиз: ${release.tag}`)

  const variants = [selection.primary, ...selection.fallbacks]

  for (const variantToken of variants) {
    const resolved = resolveAsset(release.assets, variantToken)
    if (!resolved) {
      emitBuild(win, `Бинарник '${variantToken}' не найден, пробуем следующий…`)
      continue
    }
    const { asset, variant } = resolved

    const sizeMb = Math.round(asset.size / (1024 * 1024))
    emitBuild(win, `Скачивание ${variant} (${sizeMb} МБ)…`)

    const dir = binDir()
    fs.mkdirSync(dir, { recursive: true })
    const archivePath = path.join(dir, asset.name)

    try {
      await downloadFile(asset.browser_download_url, archivePath, win, variant)
    } catch (e: any) {
      emitBuild(win, `Ошибка скачивания ${variant}: ${e.message}`)
      continue
    }

    emitBuild(win, 'Распаковка…')
    try {
      extractArchive(archivePath, dir)
    } catch (e: any) {
      emitBuild(win, `Ошибка распаковки: ${e.message}`)
      continue
    }

    // On Windows+CUDA, also download the matching cudart DLLs. Do this for whichever CUDA variant
    // we're currently attempting (not just the primary) — otherwise a fallback CUDA build would
    // fail verification for lack of its runtime and cascade all the way down to the CPU build.
    if (selection.needsCudart && variant.includes('cuda')) {
      const cudart = matchCudartAsset(release.assets, `cudart-llama-bin-${variant}`)
      if (cudart) {
        emitBuild(win, 'Скачивание CUDA runtime…')
        const cudartPath = path.join(dir, cudart.name)
        try {
          await downloadFile(cudart.browser_download_url, cudartPath, win, 'cudart')
          extractArchive(cudartPath, dir)
          try { fs.unlinkSync(cudartPath) } catch {}
        } catch (e: any) {
          emitBuild(win, `Предупреждение: не удалось скачать cudart: ${e.message}`)
        }
      }
    }

    try { fs.unlinkSync(archivePath) } catch {}

    const bin = findServerBin()
    if (!bin) {
      emitBuild(win, `llama-server не найден после распаковки ${variant}`)
      continue
    }

    if (process.platform !== 'win32') {
      try { fs.chmodSync(bin, 0o755) } catch {}
    }

    if (verifyBinary(bin)) {
      setInstalledVariant(variant)
      setInstalledTag(release.tag)
      emitBuild(win, `llama-server (${variant} ${release.tag}) готов!`)
      // If we landed on the CPU build even though a GPU is present, the CUDA/Vulkan builds all
      // failed to verify (missing runtime, incompatible driver, etc). Generation will run on the
      // CPU and be slow — make that explicit instead of failing silently (which is exactly what
      // the user hit: GPU detected, but win-cpu-x64 installed with no warning).
      const gpuPresent = res.gpus.length > 0 || res.hasAmdGpu
      if (isCpuVariant(variant) && gpuPresent) {
        const gpuNames = res.gpus.map((g) => g.name).join(', ') || (res.hasAmdGpu ? 'AMD GPU' : 'GPU')
        emitBuild(win, `⚠️ Установлена CPU-сборка llama-server, хотя обнаружен ${gpuNames}. ` +
          `GPU-сборки (CUDA/Vulkan) не запустились — генерация пойдёт на CPU и будет медленной. ` +
          `Проверьте драйвер NVIDIA/CUDA (или Vulkan runtime) и переустановите llama.cpp в настройках.`)
      }
      return bin
    }

    emitBuild(win, `Бинарник ${variant} не запускается, пробуем следующий…`)
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }

  throw new Error('Не удалось установить llama-server. Проверьте интернет-соединение.')
}

/**
 * Force-update llama.cpp to the newest GitHub release (even if one is already installed).
 * Returns the previous/new release tags and whether the tag actually changed. The caller
 * (main.ts) is responsible for restarting the server afterwards.
 */
export async function updateBinary(win: BrowserWindow): Promise<{ previousTag: string | null; tag: string | null; updated: boolean }> {
  const previousTag = getInstalledTag()
  emitBuild(win, previousTag ? `Текущая версия llama.cpp: ${previousTag}. Проверяю обновления…` : 'Проверяю последнюю версию llama.cpp…')
  await downloadAndInstallLatest(win)
  const tag = getInstalledTag()
  const updated = Boolean(tag && tag !== previousTag)
  emitBuild(win, updated ? `Обновлено: ${previousTag ?? '—'} → ${tag}` : `Уже последняя версия (${tag ?? '—'}) — переустановлено.`)
  return { previousTag, tag, updated }
}

// ---------------------------------------------------------------------------
// Start / Stop / Health
// ---------------------------------------------------------------------------

export function getServerLog(): string[] {
  return lastServerLog
}

function appendServerDebug(line: string): void {
  try {
    fs.mkdirSync(path.dirname(SERVER_LOG_FILE), { recursive: true })
    fs.appendFileSync(SERVER_LOG_FILE, `[${new Date().toISOString()}] ${line}\n`)
  } catch {}
}

export function getCtxSize(): number {
  return activeCtxSize
}

export function setCtxSize(size: number): void {
  if (size > 0) activeCtxSize = size
}

export async function queryActualCtxSize(): Promise<number | null> {
  try {
    const r = await fetch(`${llamaApiUrl()}/props`, { signal: AbortSignal.timeout(5000) })
    if (!r.ok) return null
    const json = await r.json() as any
    const realCtx = json.default_generation_settings?.n_ctx
    if (realCtx && realCtx > 0) {
      if (realCtx !== activeCtxSize) {
        console.log(`[server-manager] Server actual n_ctx=${realCtx}, was tracking ${activeCtxSize} — correcting`)
        activeCtxSize = realCtx
      }
      return realCtx
    }
    return null
  } catch {
    return null
  }
}

export function start(
  modelPath: string, win?: BrowserWindow, args?: ServerLaunchArgs,
  quant?: string, userCtxSize?: number | null,
): void {
  if (isRunning()) throw new Error('Server already running')

  // Kill any orphan llama-server processes from previous app sessions
  killOrphanServers()

  const bin = findServerBin()
  if (!bin) throw new Error('llama-server not found — run ensureBinary first')

  const cfg = config.load()
  const detected = detect()
  const effectiveResources = applyGpuPreferences(detected, cfg.gpuMode, cfg.gpuIndex)
  const selectedGpu = effectiveResources.gpus[0] ?? null
  const la = args ?? computeOptimalArgs(effectiveResources, quant, userCtxSize)
  activeCtxSize = la.ctxSize
  // Remember how to bring this exact server back up if the GPU device is lost mid-run.
  intentionalStop = false
  lastStartCtx = { modelPath, win, quant, userCtxSize }
  // Loud warning if we're about to run on a CPU-only build while a GPU is present: `--n-gpu-layers`
  // is silently ignored by CPU builds, so the app would otherwise look like it's using the GPU
  // (GPU selected in UI, layers=999) while actually running on CPU at a few tok/s.
  if (isCpuVariant(getInstalledVariant()) && (detected.gpus.length > 0 || detected.hasAmdGpu)) {
    const names = detected.gpus.map((g) => g.name).join(', ') || 'GPU'
    const warn = `⚠️ llama-server — CPU-сборка, но обнаружен ${names}. Работа пойдёт на CPU (медленно). Переустановите llama.cpp в настройках после проверки драйвера GPU.`
    appendServerDebug(`[warn] ${warn}`)
    if (win) emitBuild(win, warn)
  }
  const cmdArgs = [
    '--model', modelPath,
    '--host', LLAMA_HOST,
    '--port', String(LLAMA_PORT),
    '--jinja',
    '--n-gpu-layers', String(la.nGpuLayers),
    '--ctx-size', String(la.ctxSize),
    '--threads', String(la.threads),
    '--cache-type-k', la.cacheTypeK,
    '--cache-type-v', la.cacheTypeV,
  ]
  // Thinking vs Instruct is controlled HERE, at server launch — not per request. On current
  // llama.cpp (≥ ~b8322) the per-request `chat_template_kwargs.enable_thinking` is deprecated and
  // silently ignored (see llama.cpp #20182 / discussion #23351), so the only reliable switch is the
  // `--reasoning-budget` launch flag: 0 forces enable_thinking=false + hard sampler stop (Instruct),
  // -1 leaves reasoning unlimited (Thinking). Changing generationMode therefore restarts the server.
  cmdArgs.push('--reasoning-budget', cfg.generationMode === 'instruct' ? '0' : '-1')
  // Single slot. This is a single-user desktop agent whose turns are strictly SEQUENTIAL, and the
  // whole workflow leans hard on KV prefix reuse (stable system+history prefix + `cache_prompt`).
  // llama.cpp defaults to 4 slots here; with 4 slots the agent's turns and the (also sequential)
  // screening calls land on DIFFERENT slots and evict each other's KV, so the growing conversation
  // is re-prefilled from scratch (observed prompt-eval of 40–150s for 24k–65k tokens every turn).
  // One slot keeps the conversation KV resident across turns → only new tokens are prefilled.
  cmdArgs.push('--parallel', '1')
  // Prompt-processing (prefill) throughput scales with the logical batch size. In llama.cpp
  // the compute-buffer VRAM cost is driven by the *physical* micro-batch (--ubatch-size),
  // NOT the logical --batch-size, so a large --batch-size speeds up prefill at negligible
  // memory cost. The previous code forced --batch-size 512 (a quarter of the 2048 default)
  // at large contexts, which throttled prefill without saving VRAM. Restore a healthy
  // logical batch and only scale the physical micro-batch up when there's VRAM headroom.
  // The physical micro-batch (--ubatch-size 512) is kept at the default to bound activation
  // VRAM (raising it yields only a marginal, usually imperceptible prefill gain). The logical
  // --batch-size is restored to the 2048 default so large-context runs ingest prompts at full
  // speed instead of being throttled to 512.
  if (la.nGpuLayers > 0) {
    cmdArgs.push('--batch-size', '2048', '--ubatch-size', '512')
  }
  // Lock model in RAM to avoid swap (consistent speed on local machine)
  if (process.platform !== 'win32') cmdArgs.push('--mlock')
  if (la.tensorSplit) cmdArgs.push('--tensor-split', la.tensorSplit)
  if (la.flashAttn) cmdArgs.push('--flash-attn', 'on')

  lastServerLog = []
  appendServerDebug('--- llama-server start ---')
  appendServerDebug(`bin=${bin}`)
  appendServerDebug(`args=${cmdArgs.map((a) => JSON.stringify(a)).join(' ')}`)
  appendServerDebug(`gpuMode=${cfg.gpuMode}, gpuIndex=${cfg.gpuIndex}, detectedGpus=${detected.gpus.map((gpu) => `${gpu.index}:${gpu.name}:${gpu.vramFreeMb}/${gpu.vramTotalMb}MB`).join('; ')}`)
  appendServerDebug(`launch: nGpuLayers=${la.nGpuLayers}, ctx=${la.ctxSize}, threads=${la.threads}, cache=${la.cacheTypeK}/${la.cacheTypeV}, tensorSplit=${la.tensorSplit ?? '-'}, flashAttn=${la.flashAttn}`)
  // CUDA graphs give a meaningful (~5–15%) decode speedup on a single GPU, but can be
  // unstable across multiple GPUs (P2P). Only disable them when we're actually spanning
  // more than one device; keep them ON for the common single-GPU case.
  const singleGpuPinned = cfg.gpuMode === 'single' && !!selectedGpu
  const usingMultiGpu = !singleGpuPinned && effectiveResources.gpus.length > 1
  if (win) {
    emitBuild(win, `Запуск: ${path.basename(bin)}`)
    if (usingMultiGpu) emitBuild(win, 'GGML_CUDA_DISABLE_GRAPHS=1 (multi-GPU stability)')
    else emitBuild(win, 'CUDA graphs: on (single-GPU)')
    if (cfg.gpuMode === 'single' && selectedGpu) {
      emitBuild(win, `GPU mode: single (GPU ${selectedGpu.index}: ${selectedGpu.name})`)
      emitBuild(win, `Visible GPU env: CUDA_VISIBLE_DEVICES=${selectedGpu.index}, GGML_VK_VISIBLE_DEVICES=${selectedGpu.index}`)
    } else if (cfg.gpuMode === 'split' && detected.gpus.length > 1) {
      emitBuild(win, `GPU mode: split (experimental, GPUs: ${detected.gpus.map((gpu) => gpu.index).join(', ')})`)
    }
    emitBuild(win, `GPU layers: ${la.nGpuLayers}, ctx: ${la.ctxSize}, threads: ${la.threads}` +
      `, kv-cache: ${la.cacheTypeK}` +
      (la.tensorSplit ? `, tensor-split: ${la.tensorSplit}` : '') +
      (la.flashAttn ? ', flash-attn: on' : ''))
  }

  const spawnEnv: NodeJS.ProcessEnv = { ...process.env }
  if (usingMultiGpu) spawnEnv.GGML_CUDA_DISABLE_GRAPHS = '1'
  else delete spawnEnv.GGML_CUDA_DISABLE_GRAPHS
  if (cfg.gpuMode === 'single' && selectedGpu) {
    spawnEnv.CUDA_VISIBLE_DEVICES = String(selectedGpu.index)
    spawnEnv.GGML_VK_VISIBLE_DEVICES = String(selectedGpu.index)
  } else {
    delete spawnEnv.CUDA_VISIBLE_DEVICES
    delete spawnEnv.GGML_VK_VISIBLE_DEVICES
  }
  appendServerDebug(`env: CUDA_VISIBLE_DEVICES=${spawnEnv.CUDA_VISIBLE_DEVICES ?? '-'}, GGML_VK_VISIBLE_DEVICES=${spawnEnv.GGML_VK_VISIBLE_DEVICES ?? '-'}, GGML_CUDA_DISABLE_GRAPHS=${spawnEnv.GGML_CUDA_DISABLE_GRAPHS ?? '-'}`)
  serverProcess = spawn(bin, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'], detached: false, env: spawnEnv })

  const handleOutput = (data: Buffer) => {
    const lines = data.toString().split('\n').filter(Boolean)
    for (const line of lines) {
      lastServerLog.push(line)
      if (lastServerLog.length > 200) lastServerLog.shift()
      appendServerDebug(`[server] ${line}`)
      if (win) emitBuild(win, `[server] ${line}`)
      // A lost GPU device never recovers in place — llama.cpp keeps failing every decode. Kill &
      // relaunch so the app self-heals instead of appearing to "crash" (all requests error out).
      if (FATAL_GPU_RE.test(line)) scheduleGpuRecovery(win, line)
    }
  }

  serverProcess.stdout?.on('data', handleOutput)
  serverProcess.stderr?.on('data', handleOutput)
  serverProcess.on('error', (err) => {
    appendServerDebug(`[process-error] ${err.message}`)
  })
  serverProcess.on('exit', (code, signal) => {
    appendServerDebug(`[exit] code=${code ?? 'null'} signal=${signal ?? 'null'}`)
    if (win && code !== null && code !== 0) {
      emitBuild(win, `llama-server завершился с кодом ${code}`)
    }
    serverProcess = null
    // Abnormal, unrequested exit (crash / killed by driver) → try to self-heal. Intentional
    // stops/restarts set `intentionalStop`, so this only fires on genuine crashes.
    const abnormal = intentionalStop ? false : (code === null ? signal !== 'SIGTERM' : code !== 0)
    if (abnormal && !recovering) scheduleGpuRecovery(win, `exit code=${code ?? 'null'} signal=${signal ?? 'null'}`)
  })
}

export function stop(): void {
  intentionalStop = true
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM')
    setTimeout(() => {
      if (serverProcess && serverProcess.exitCode === null) serverProcess.kill('SIGKILL')
    }, 10000)
  }
  serverProcess = null
  killOrphanServers()
}

function killOrphanServers(): void {
  try {
    if (process.platform === 'win32') {
      execSync(`for /f "tokens=5" %a in ('netstat -aon ^| findstr :${LLAMA_PORT} ^| findstr LISTENING') do taskkill /F /PID %a`, { timeout: 5000, stdio: 'ignore' })
    } else {
      // CRITICAL: filter to processes LISTENING on the port (the llama-server itself), NOT
      // every process with a socket on it. A plain `lsof -ti :PORT` also returns CLIENT
      // connections — including this Electron app's own keep-alive sockets to llama-server —
      // so SIGKILLing those PIDs would kill the app (it "just closed" on the user). The
      // -sTCP:LISTEN state filter keeps only the server; we also never kill our own PID.
      const out = execSync(`lsof -ti tcp:${LLAMA_PORT} -sTCP:LISTEN 2>/dev/null || true`, { timeout: 5000, encoding: 'utf-8' }).trim()
      if (out) {
        const killed: string[] = []
        for (const pid of out.split('\n').filter(Boolean)) {
          const n = parseInt(pid)
          if (!Number.isFinite(n) || n === process.pid || n === process.ppid) continue
          try { process.kill(n, 'SIGKILL'); killed.push(pid) } catch {}
        }
        if (killed.length) console.log(`[server-manager] Killed orphan llama-server(s) on port ${LLAMA_PORT}: ${killed.join(', ')}`)
      }
    }
  } catch {}
}

/**
 * Recover from a fatal GPU fault (Vulkan `ErrorDeviceLost`, CUDA illegal access, or an abnormal
 * crash): kill the wedged server and relaunch it with the same model/ctx so the app self-heals
 * instead of silently dying on the user. Capped at 3 attempts / 5 min — if the GPU stays wedged
 * (often needs a driver/system reboot) we stop and surface a clear message rather than loop.
 */
function scheduleGpuRecovery(win: BrowserWindow | undefined, reason: string): void {
  if (recovering) return
  recovering = true
  const now = Date.now()
  recentAutoRestarts = recentAutoRestarts.filter((t) => now - t < 5 * 60_000)
  if (recentAutoRestarts.length >= 3) {
    appendServerDebug(`[gpu-recovery] giving up after repeated restarts (${reason}) — GPU likely wedged`)
    if (win) emitBuild(win, 'GPU повторно теряет устройство. Похоже, драйвер завис — помогает перезагрузка системы/драйвера.')
    recovering = false
    return
  }
  recentAutoRestarts.push(now)
  appendServerDebug(`[gpu-recovery] fatal GPU fault (${reason}) — restarting llama-server`)
  if (win) emitBuild(win, 'GPU device lost — автоматически перезапускаю модельный сервер…')

  const ctx = lastStartCtx
  intentionalStop = true
  try { serverProcess?.kill('SIGKILL') } catch {}
  setTimeout(() => {
    try { killOrphanServers() } catch {}
    intentionalStop = false
    recovering = false
    if (!ctx) return
    try {
      start(ctx.modelPath, ctx.win ?? win, undefined, ctx.quant, ctx.userCtxSize)
      void waitReady(300, ctx.win ?? win).catch((e) =>
        appendServerDebug(`[gpu-recovery] waitReady after restart failed: ${String(e?.message || e)}`))
    } catch (e: any) {
      appendServerDebug(`[gpu-recovery] restart failed: ${String(e?.message || e)}`)
    }
  }, 2500)
}

export async function waitReady(timeoutSecs = 300, win?: BrowserWindow): Promise<boolean> {
  const deadline = Date.now() + timeoutSecs * 1000
  let lastReport = 0
  while (Date.now() < deadline) {
    if (!serverProcess || serverProcess.exitCode !== null) {
      const code = serverProcess?.exitCode ?? 'unknown'
      const tail = lastServerLog.slice(-10).join('\n')
      throw new Error(
        `llama-server упал (код ${code}).\nПоследний вывод:\n${tail}`
      )
    }

    try {
      const r = await fetch(`${llamaApiUrl()}/health`, { signal: AbortSignal.timeout(3000) })
      const body = await r.json() as any
      if (body.status === 'ok') {
        await queryActualCtxSize()
        return true
      }
      if (body.status === 'loading model' && win) {
        const now = Date.now()
        if (now - lastReport > 3000) {
          const pct = body.progress !== undefined ? ` (${Math.round(body.progress * 100)}%)` : ''
          emitBuild(win, `Загрузка модели в память${pct}…`)
          lastReport = now
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1500))
  }
  const tail = lastServerLog.slice(-10).join('\n')
  throw new Error(
    `Сервер не ответил за ${timeoutSecs} секунд.\nПоследний вывод:\n${tail}`
  )
}

export async function health(): Promise<{ status: string }> {
  try {
    const r = await fetch(`${llamaApiUrl()}/health`, { signal: AbortSignal.timeout(5000) })
    return await r.json() as { status: string }
  } catch {
    return { status: 'unreachable' }
  }
}
