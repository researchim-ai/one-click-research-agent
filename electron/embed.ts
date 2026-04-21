import { spawn, ChildProcess, execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as https from 'https'

const EMBED_HOST = '127.0.0.1'
const EMBED_PORT = 18081

const MODELS_DIR = path.join(os.homedir(), '.one-click-agent', 'models')
const DEFAULT_MODEL_URL = 'https://huggingface.co/BAAI/bge-m3/resolve/main/gguf/bge-m3-Q4_K_M.gguf'
const DEFAULT_MODEL_FILE = 'bge-m3-Q4_K_M.gguf'

let embedProcess: ChildProcess | null = null
let lastLog: string[] = []
let activeModelPath: string | null = null

export function embedApiUrl(): string {
  return `http://${EMBED_HOST}:${EMBED_PORT}`
}

function serverBinName(): string {
  return process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
}

function dataDir(): string {
  return path.join(os.homedir(), '.one-click-agent')
}

function binDir(): string {
  return path.join(dataDir(), 'llama-bin')
}

function findServerBin(): string | null {
  const dir = binDir()
  const binPath = path.join(dir, serverBinName())
  if (fs.existsSync(binPath)) return binPath
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const nested = path.join(dir, entry.name, serverBinName())
        if (fs.existsSync(nested)) return nested
      }
    }
  } catch {}
  try {
    const which = execSync(
      process.platform === 'win32' ? 'where llama-server' : 'which llama-server',
      { encoding: 'utf-8', timeout: 5000 },
    ).trim().split('\n')[0]
    if (which) return which
  } catch {}
  return null
}

export function getDefaultEmbedModelPath(): string {
  return path.join(MODELS_DIR, DEFAULT_MODEL_FILE)
}

export function isDefaultModelDownloaded(): boolean {
  return fs.existsSync(getDefaultEmbedModelPath())
}

export function isRunning(): boolean {
  return !!(embedProcess && embedProcess.exitCode === null)
}

/** Fetch via HTTPS with redirects. */
function httpsGet(url: string, out: fs.WriteStream, onProgress?: (done: number, total: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'one-click-research-agent/0.1' } }, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location) {
        const nextUrl = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).toString()
        res.resume()
        httpsGet(nextUrl, out, onProgress).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} downloading ${url}`))
        return
      }
      const total = Number(res.headers['content-length'] || 0)
      let done = 0
      res.on('data', (chunk) => {
        done += chunk.length
        if (onProgress && total) onProgress(done, total)
      })
      res.pipe(out)
      res.on('end', () => resolve())
      res.on('error', reject)
    }).on('error', reject)
  })
}

export async function downloadDefaultModel(onProgress?: (pct: number) => void): Promise<string> {
  fs.mkdirSync(MODELS_DIR, { recursive: true })
  const target = getDefaultEmbedModelPath()
  if (fs.existsSync(target)) return target
  const tmp = target + '.part'
  const out = fs.createWriteStream(tmp)
  try {
    await httpsGet(DEFAULT_MODEL_URL, out, (done, total) => {
      if (onProgress) onProgress(Math.round((done / total) * 100))
    })
  } finally {
    out.close()
  }
  fs.renameSync(tmp, target)
  return target
}

export async function startEmbedServer(modelPath?: string): Promise<void> {
  if (isRunning()) return
  const bin = findServerBin()
  if (!bin) throw new Error('llama-server binary not found — ensure the main server is installed first.')
  const model = modelPath || getDefaultEmbedModelPath()
  if (!fs.existsSync(model)) throw new Error(`Embed model not found: ${model}`)

  const args = [
    '-m', model,
    '--host', EMBED_HOST,
    '--port', String(EMBED_PORT),
    '--embedding',
    '--pooling', 'mean',
    '-c', '8192',
    '-ngl', '0',
    '-t', String(Math.max(2, Math.floor(os.cpus().length / 2))),
  ]
  lastLog = []
  activeModelPath = model
  embedProcess = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const appendLog = (data: Buffer) => {
    const str = data.toString('utf-8')
    for (const line of str.split('\n')) {
      if (line.trim()) {
        lastLog.push(line)
        if (lastLog.length > 200) lastLog.shift()
      }
    }
  }
  embedProcess.stdout?.on('data', appendLog)
  embedProcess.stderr?.on('data', appendLog)
  embedProcess.on('exit', () => { embedProcess = null })

  // Wait for ready
  const start = Date.now()
  while (Date.now() - start < 45000) {
    try {
      const r = await fetch(`${embedApiUrl()}/health`).catch(() => null)
      if (r && r.ok) return
    } catch {}
    if (!isRunning()) throw new Error(`Embed server exited. Log: ${lastLog.slice(-5).join(' | ')}`)
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('Embed server did not become healthy in 45s')
}

export function stopEmbedServer(): void {
  if (embedProcess) {
    try { embedProcess.kill() } catch {}
    embedProcess = null
  }
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!isRunning()) throw new Error('Embed server is not running')
  if (!texts || texts.length === 0) return []
  const url = `${embedApiUrl()}/v1/embeddings`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: texts, model: 'bge-m3' }),
  })
  if (!res.ok) throw new Error(`Embed request failed: HTTP ${res.status}`)
  const json: any = await res.json()
  const data = Array.isArray(json?.data) ? json.data : []
  return data.map((d: any) => d.embedding as number[])
}

export function getActiveModelPath(): string | null {
  return activeModelPath
}

export function getLastLog(): string {
  return lastLog.slice(-30).join('\n')
}
