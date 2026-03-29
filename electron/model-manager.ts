import { BrowserWindow } from 'electron'
import https from 'https'
import fs from 'fs'
import path from 'path'
import os from 'os'
import type { DownloadProgress, ModelVariant } from './types'
import * as config from './config'
import { MODEL_VARIANTS } from './resources'

const DEFAULT_REPO_ID = 'unsloth/Qwen3.5-35B-A3B-GGUF'
const DEFAULT_QUANT = 'UD-Q4_K_XL'

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/-/g, '_')
}

function is9BQuant(quant: string): boolean {
  return quant.startsWith('9B-')
}

function matchesQuantFile(filename: string, quant: string): boolean {
  const normalized = normalizeToken(filename)
  const quantNorm = normalizeToken(quant)
  if (!normalized.includes(quantNorm)) return false

  const is9BFile = normalized.includes('9b')
  return is9BQuant(quant) ? is9BFile : !is9BFile
}

function findInstalledModelFile(files: string[], quant: string): string | null {
  const exactFamilyMatch = files.find((file) => matchesQuantFile(file, quant))
  if (exactFamilyMatch) return exactFamilyMatch

  const quantNorm = normalizeToken(quant)
  return files.find((file) => normalizeToken(file).includes(quantNorm)) ?? null
}

function getRepoId(quant?: string): string {
  const q = quant ?? selectedQuant
  const variant = MODEL_VARIANTS.find((v: ModelVariant) => v.quant === q)
  if (variant?.repoId) return variant.repoId
  return DEFAULT_REPO_ID
}
const MAX_RETRIES = 3
const RETRY_BASE_MS = 2000

let selectedQuant: string = config.get('lastQuant') || DEFAULT_QUANT

export function getSelectedQuant(): string {
  return selectedQuant
}

export function setSelectedQuant(q: string) {
  selectedQuant = q
  config.set('lastQuant', q)
}

export function dataDir(): string {
  const d = path.join(os.homedir(), '.one-click-agent')
  fs.mkdirSync(d, { recursive: true })
  return d
}

export function modelsDir(): string {
  const d = path.join(dataDir(), 'models')
  fs.mkdirSync(d, { recursive: true })
  return d
}

export function getModelPath(): string | null {
  const dir = modelsDir()
  if (!fs.existsSync(dir)) return null
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.gguf'))
  const match = findInstalledModelFile(files, selectedQuant)
  if (match) return path.join(dir, match)
  return files.length > 0 ? path.join(dir, files[0]) : null
}

export function isDownloaded(): boolean {
  const dir = modelsDir()
  if (!fs.existsSync(dir)) return false
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.gguf'))
  return findInstalledModelFile(files, selectedQuant) !== null
}

interface HfSibling {
  rfilename: string
}

async function findModelFilename(quant?: string): Promise<string> {
  const q = quant ?? selectedQuant
  const repoId = getRepoId(q)
  const url = `https://huggingface.co/api/models/${repoId}`
  const body = await fetchJson(url)
  const siblings: HfSibling[] = body.siblings ?? []
  const quantNorm = q.toLowerCase().replace(/-/g, '_')
  const match = siblings
    .filter((s) => s.rfilename.endsWith('.gguf'))
    .find((s) => s.rfilename.toLowerCase().replace(/-/g, '_').includes(quantNorm))

  if (!match) {
    const available = siblings.filter((s) => s.rfilename.endsWith('.gguf')).map((s) => s.rfilename)
    throw new Error(`Quant '${q}' not found. Available: ${available.join(', ')}`)
  }
  return match.rfilename
}

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const get = (u: string) => {
      https.get(u, { headers: { 'User-Agent': 'one-click-agent/0.1' } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          get(res.headers.location)
          return
        }
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
        })
        res.on('error', reject)
      }).on('error', reject)
    }
    get(url)
  })
}

function emitProgress(win: BrowserWindow, p: DownloadProgress) {
  win.webContents.send('download-progress', p)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function downloadWithResume(
  url: string, dest: string, win: BrowserWindow, attempt: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tmp = dest + '.part'
    let existingBytes = 0
    try {
      const stat = fs.statSync(tmp)
      existingBytes = stat.size
    } catch {}

    const doGet = (u: string) => {
      const headers: Record<string, string> = { 'User-Agent': 'one-click-agent/0.1' }
      if (existingBytes > 0) {
        headers['Range'] = `bytes=${existingBytes}-`
      }

      https.get(u, { headers }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          doGet(res.headers.location)
          return
        }

        const isPartial = res.statusCode === 206
        const isOk = res.statusCode === 200

        if (!isOk && !isPartial) {
          reject(new Error(`HTTP ${res.statusCode}`))
          return
        }

        // If server ignores Range and sends full file, reset
        if (isOk && existingBytes > 0) {
          existingBytes = 0
        }

        const contentLength = parseInt(res.headers['content-length'] ?? '0', 10)
        const total = isPartial ? existingBytes + contentLength : contentLength
        const totalMb = Math.round(total / (1024 * 1024))
        let downloaded = existingBytes
        let lastEmit = 0

        const file = fs.createWriteStream(tmp, { flags: isPartial ? 'a' : 'w' })
        res.pipe(file)

        res.on('data', (chunk: Buffer) => {
          downloaded += chunk.length
          const now = Date.now()
          if (now - lastEmit > 500) {
            const dm = Math.round(downloaded / (1024 * 1024))
            const pct = total > 0 ? (downloaded / total) * 100 : 0
            emitProgress(win, {
              downloadedMb: dm,
              totalMb,
              percent: Math.round(pct * 10) / 10,
              status: `${dm} / ${totalMb} МБ (${pct.toFixed(1)}%)${attempt > 1 ? ` [попытка ${attempt}]` : ''}`,
            })
            lastEmit = now
          }
        })

        file.on('finish', () => {
          file.close()
          fs.renameSync(tmp, dest)
          emitProgress(win, { downloadedMb: totalMb, totalMb, percent: 100, status: 'Модель скачана!' })
          resolve()
        })

        res.on('error', (e) => reject(e))
        file.on('error', (e) => reject(e))
      }).on('error', reject)
    }
    doGet(url)
  })
}

export async function download(win: BrowserWindow): Promise<string> {
  emitProgress(win, { downloadedMb: 0, totalMb: 0, percent: 0, status: 'Поиск файла модели…' })

  const filename = await findModelFilename()
  const dest = path.join(modelsDir(), filename)

  if (fs.existsSync(dest)) {
    emitProgress(win, { downloadedMb: 1, totalMb: 1, percent: 100, status: 'Модель уже скачана' })
    return dest
  }

  const repoId = getRepoId()
  const url = `https://huggingface.co/${repoId}/resolve/main/${filename}`
  emitProgress(win, { downloadedMb: 0, totalMb: 0, percent: 0, status: `Скачивание ${filename}…` })

  let lastError: Error | null = null

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await downloadWithResume(url, dest, win, attempt)
      return dest
    } catch (e: any) {
      lastError = e
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1)
        emitProgress(win, {
          downloadedMb: 0, totalMb: 0, percent: 0,
          status: `Ошибка: ${e.message}. Повтор через ${delay / 1000}с…`,
        })
        await sleep(delay)
      }
    }
  }

  throw lastError ?? new Error('Download failed')
}
