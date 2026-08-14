import { execFile, execFileSync, execSync } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AppConfig } from './config'
import type { WebSearchStatus } from './types'

const execFileAsync = promisify(execFile)

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const MANAGED_SEARXNG_PORT = 18080
const MANAGED_SEARXNG_IMAGE = 'docker.io/searxng/searxng:latest'
const MANAGED_SEARXNG_CONTAINER = 'one-click-agent-searxng'

function configPath(): string {
  return path.join(os.homedir(), '.one-click-agent', 'config.json')
}

function normalizeBaseUrl(raw: string | null | undefined): string | null {
  const value = String(raw ?? '').trim()
  if (!value) return null
  return value.replace(/\/+$/, '')
}

function managedBaseUrl(): string {
  return `http://127.0.0.1:${MANAGED_SEARXNG_PORT}`
}

function runNodeScript(source: string, args: string[]): string {
  return execFileSync(process.execPath, ['-e', source, ...args], {
    encoding: 'utf-8',
    timeout: 120000,
    maxBuffer: 1024 * 1024 * 10,
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      ELECTRON_RUN_AS_NODE: '1',
    },
  })
}

function runDocker(args: string[], timeout = 120000): string {
  return execFileSync('docker', args, {
    encoding: 'utf-8',
    timeout,
    maxBuffer: 1024 * 1024 * 10,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

export function dockerAvailable(): boolean {
  try {
    execSync('docker --version', { stdio: 'ignore', timeout: 5000 })
    return true
  } catch {
    return false
  }
}

function inspectContainerState(): 'missing' | 'running' | 'stopped' {
  try {
    const out = runDocker(['inspect', '-f', '{{.State.Running}}', MANAGED_SEARXNG_CONTAINER], 10000).trim()
    return out === 'true' ? 'running' : 'stopped'
  } catch {
    return 'missing'
  }
}

function ensureCacheDir(): string {
  const dir = path.join(os.homedir(), '.one-click-agent', 'searxng-cache')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function healthcheck(baseUrl: string): boolean {
  const script = `
const baseUrl = process.argv[1]
fetch(baseUrl + '/search?q=healthcheck&format=json', {
  headers: { 'User-Agent': 'one-click-research-agent/0.1', Accept: 'application/json' },
  signal: AbortSignal.timeout(5000),
}).then(async (res) => {
  if (!res.ok) throw new Error('HTTP ' + res.status)
  await res.text()
  process.stdout.write('ok')
}).catch(() => {
  process.exit(1)
})
`
  try {
    return runNodeScript(script, [baseUrl]).trim() === 'ok'
  } catch {
    return false
  }
}

function managedLogsTail(lines = 80): string {
  try {
    return runDocker(['logs', '--tail', String(lines), MANAGED_SEARXNG_CONTAINER], 15000).trim()
  } catch (e: any) {
    return String(e?.stderr || e?.message || e).trim()
  }
}

function removeManagedContainer(): void {
  try {
    runDocker(['rm', '-f', MANAGED_SEARXNG_CONTAINER], 30000)
  } catch {}
}

function createManagedContainer(): void {
  const cacheDir = ensureCacheDir()
  runDocker(['pull', MANAGED_SEARXNG_IMAGE], 300000)
  runDocker([
    'run', '-d',
    '--name', MANAGED_SEARXNG_CONTAINER,
    '-p', `127.0.0.1:${MANAGED_SEARXNG_PORT}:8080`,
    '-v', `${cacheDir}:/var/cache/searxng`,
    MANAGED_SEARXNG_IMAGE,
  ], 120000)
}

const JSON_API_PATCH_SCRIPT = `
from pathlib import Path

path = Path('/etc/searxng/settings.yml')
lines = path.read_text().splitlines() if path.exists() else []
try:
    search_start = next(i for i, line in enumerate(lines) if line.strip() == 'search:')
except StopIteration:
    if lines and lines[-1].strip():
        lines.append('')
    lines.extend(['search:', '  formats:', '    - html', '    - json'])
    path.write_text('\\n'.join(lines) + '\\n')
    print('patched')
    raise SystemExit(0)

search_end = len(lines)
for i in range(search_start + 1, len(lines)):
    line = lines[i]
    if line and not line.startswith(' '):
        search_end = i
        break

try:
    formats_start = next(i for i in range(search_start + 1, search_end) if lines[i].strip() == 'formats:')
except StopIteration:
    insert_at = search_start + 1
    updated_lines = lines[:insert_at] + ['  formats:', '    - html', '    - json'] + lines[insert_at:]
    path.write_text('\\n'.join(updated_lines) + '\\n')
    print('patched')
    raise SystemExit(0)

formats_end = formats_start + 1
while formats_end < search_end and (lines[formats_end].startswith('    - ') or lines[formats_end].strip().startswith('- ')):
    formats_end += 1

replacement = ['  formats:', '    - html', '    - json']
updated_lines = lines[:formats_start] + replacement + lines[formats_end:]
if updated_lines != lines:
    path.write_text('\\n'.join(updated_lines) + '\\n')
    print('patched')
elif any(line.strip() == '- json' for line in lines):
    print('ok')
else:
    raise SystemExit('failed to enable json format in settings.yml')
`

function ensureManagedJsonApiEnabled(): void {
  const out = runDocker(['exec', MANAGED_SEARXNG_CONTAINER, 'python', '-c', JSON_API_PATCH_SCRIPT], 30000).trim()
  if (out === 'patched') {
    runDocker(['restart', MANAGED_SEARXNG_CONTAINER], 120000)
  }
}

function waitForHealthy(baseUrl: string, timeoutMs = 60000): void {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (healthcheck(baseUrl)) return
    execSync('sleep 2', { stdio: 'ignore', timeout: 3000 })
  }
  const logs = managedLogsTail(80)
  throw new Error(`SearXNG did not become healthy in time.\nRecent container logs:\n${logs}`)
}

// Once the managed container has been verified healthy we cache it for a short
// window so back-to-back search_web calls don't re-run the expensive ensure path
// (docker exec to patch settings + potential restart) on the synchronous worker
// thread. healthcheck() queries the JSON API, so a passing check also proves the
// json format is enabled — making the fast path correctness-safe.
let managedVerifiedAt = 0
const MANAGED_VERIFY_TTL_MS = 5 * 60 * 1000

export function ensureManagedSearxng(): string {
  if (!dockerAvailable()) {
    throw new Error('Docker is not available. Switch web search mode to "Existing SearXNG URL" or install Docker.')
  }

  const cachedBaseUrl = managedBaseUrl()
  if (Date.now() - managedVerifiedAt < MANAGED_VERIFY_TTL_MS) {
    return cachedBaseUrl
  }
  // Not in the TTL window, but if it's already serving the JSON API just refresh
  // the timestamp and return — no need to touch Docker at all.
  if (healthcheck(cachedBaseUrl)) {
    managedVerifiedAt = Date.now()
    return cachedBaseUrl
  }

  const state = inspectContainerState()
  if (state === 'missing') {
    createManagedContainer()
  } else if (state === 'stopped') {
    removeManagedContainer()
    createManagedContainer()
  }

  try {
    ensureManagedJsonApiEnabled()
    const baseUrl = managedBaseUrl()
    waitForHealthy(baseUrl)
    managedVerifiedAt = Date.now()
    return baseUrl
  } catch {
    removeManagedContainer()
    createManagedContainer()
    ensureManagedJsonApiEnabled()
    const baseUrl = managedBaseUrl()
    waitForHealthy(baseUrl)
    managedVerifiedAt = Date.now()
    return baseUrl
  }
}

export function ensureWebSearchBackend(cfg: Pick<AppConfig, 'webSearchProvider' | 'searxngBaseUrl'>): WebSearchStatus {
  if (cfg.webSearchProvider === 'disabled') {
    return getWebSearchStatus(cfg)
  }

  if (cfg.webSearchProvider === 'custom-searxng') {
    const baseUrl = normalizeBaseUrl(cfg.searxngBaseUrl)
    if (!baseUrl) {
      throw new Error('Custom SearXNG URL is empty.')
    }
    if (!healthcheck(baseUrl)) {
      throw new Error(`Custom SearXNG is unreachable at ${baseUrl}.`)
    }
    return getWebSearchStatus(cfg)
  }

  ensureManagedSearxng()
  return getWebSearchStatus(cfg)
}

// ---------------------------------------------------------------------------
// Async (non-blocking) variants for the Electron MAIN process.
//
// The sync functions above spawn Docker via execFileSync and busy-wait with
// execSync('sleep') — fine on the agent-worker (a separate process), but on the
// main process a first-run `docker pull` (up to 5 min) froze the event loop, so
// the OS showed "one-click-research-agent is not responding". These awaited
// variants keep the main event loop free while the container is pulled/started.
// ---------------------------------------------------------------------------

async function runDockerAsync(args: string[], timeout = 120000): Promise<string> {
  const { stdout } = await execFileAsync('docker', args, {
    encoding: 'utf-8',
    timeout,
    maxBuffer: 1024 * 1024 * 10,
  })
  return stdout
}

async function dockerAvailableAsync(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['--version'], { timeout: 5000 })
    return true
  } catch {
    return false
  }
}

async function healthcheckAsync(baseUrl: string): Promise<boolean> {
  return (await probeSearxngAsync(baseUrl)).jsonOk
}

type SearxngProbe = {
  /** TCP/HTTP layer responded at all (even with an error status). */
  reachable: boolean
  /** The JSON search API returned parseable JSON — required for search_web to work. */
  jsonOk: boolean
  status?: number
  error?: string
}

// Distinguishes the three states that all previously collapsed into "unreachable":
//   1. jsonOk           — JSON API works, fully usable.
//   2. reachable only   — host answers but the JSON API is blocked/disabled (very common:
//                         `formats: [html]` only, or a limiter/bot-detection). The browser
//                         still works because it uses the HTML UI, not the JSON API.
//   3. neither          — genuinely unreachable (wrong URL/port, firewall, not running).
async function probeSearxngAsync(baseUrl: string): Promise<SearxngProbe> {
  try {
    const res = await fetch(`${baseUrl}/search?q=healthcheck&format=json`, {
      headers: { 'User-Agent': 'one-click-research-agent/0.1', Accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) return { reachable: true, jsonOk: false, status: res.status }
    const text = await res.text()
    try {
      JSON.parse(text)
      return { reachable: true, jsonOk: true, status: res.status }
    } catch {
      // 200 but not JSON (e.g. an HTML page/limiter interstitial) → JSON API not usable.
      return { reachable: true, jsonOk: false, status: res.status }
    }
  } catch (jsonErr: any) {
    // JSON request failed at the network layer — probe the HTML root to tell "host is up but
    // JSON blocked" apart from "host is completely unreachable".
    try {
      const res2 = await fetch(baseUrl, {
        headers: { 'User-Agent': 'one-click-research-agent/0.1' },
        signal: AbortSignal.timeout(6000),
      })
      return { reachable: true, jsonOk: false, status: res2.status }
    } catch (rootErr: any) {
      return { reachable: false, jsonOk: false, error: String(rootErr?.message || jsonErr?.message || rootErr || jsonErr) }
    }
  }
}

async function inspectContainerStateAsync(): Promise<'missing' | 'running' | 'stopped'> {
  try {
    const out = (await runDockerAsync(['inspect', '-f', '{{.State.Running}}', MANAGED_SEARXNG_CONTAINER], 10000)).trim()
    return out === 'true' ? 'running' : 'stopped'
  } catch {
    return 'missing'
  }
}

async function managedLogsTailAsync(lines = 80): Promise<string> {
  try {
    return (await runDockerAsync(['logs', '--tail', String(lines), MANAGED_SEARXNG_CONTAINER], 15000)).trim()
  } catch (e: any) {
    return String(e?.stderr || e?.message || e).trim()
  }
}

async function removeManagedContainerAsync(): Promise<void> {
  try {
    await runDockerAsync(['rm', '-f', MANAGED_SEARXNG_CONTAINER], 30000)
  } catch {}
}

async function createManagedContainerAsync(): Promise<void> {
  const cacheDir = ensureCacheDir()
  await runDockerAsync(['pull', MANAGED_SEARXNG_IMAGE], 300000)
  await runDockerAsync([
    'run', '-d',
    '--name', MANAGED_SEARXNG_CONTAINER,
    '-p', `127.0.0.1:${MANAGED_SEARXNG_PORT}:8080`,
    '-v', `${cacheDir}:/var/cache/searxng`,
    MANAGED_SEARXNG_IMAGE,
  ], 120000)
}

async function ensureManagedJsonApiEnabledAsync(): Promise<void> {
  const out = (await runDockerAsync(['exec', MANAGED_SEARXNG_CONTAINER, 'python', '-c', JSON_API_PATCH_SCRIPT], 30000)).trim()
  if (out === 'patched') {
    await runDockerAsync(['restart', MANAGED_SEARXNG_CONTAINER], 120000)
  }
}

async function waitForHealthyAsync(baseUrl: string, timeoutMs = 60000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await healthcheckAsync(baseUrl)) return
    await delay(2000)
  }
  const logs = await managedLogsTailAsync(80)
  throw new Error(`SearXNG did not become healthy in time.\nRecent container logs:\n${logs}`)
}

export async function ensureManagedSearxngAsync(): Promise<string> {
  if (!(await dockerAvailableAsync())) {
    throw new Error('Docker is not available. Switch web search mode to "Existing SearXNG URL" or install Docker.')
  }
  const cachedBaseUrl = managedBaseUrl()
  if (Date.now() - managedVerifiedAt < MANAGED_VERIFY_TTL_MS) return cachedBaseUrl
  if (await healthcheckAsync(cachedBaseUrl)) {
    managedVerifiedAt = Date.now()
    return cachedBaseUrl
  }

  const state = await inspectContainerStateAsync()
  if (state === 'missing') {
    await createManagedContainerAsync()
  } else if (state === 'stopped') {
    await removeManagedContainerAsync()
    await createManagedContainerAsync()
  }

  try {
    await ensureManagedJsonApiEnabledAsync()
    const baseUrl = managedBaseUrl()
    await waitForHealthyAsync(baseUrl)
    managedVerifiedAt = Date.now()
    return baseUrl
  } catch {
    await removeManagedContainerAsync()
    await createManagedContainerAsync()
    await ensureManagedJsonApiEnabledAsync()
    const baseUrl = managedBaseUrl()
    await waitForHealthyAsync(baseUrl)
    managedVerifiedAt = Date.now()
    return baseUrl
  }
}

export async function ensureWebSearchBackendAsync(cfg: Pick<AppConfig, 'webSearchProvider' | 'searxngBaseUrl'>): Promise<WebSearchStatus> {
  if (cfg.webSearchProvider === 'disabled') {
    return getWebSearchStatusAsync(cfg)
  }
  if (cfg.webSearchProvider === 'custom-searxng') {
    const baseUrl = normalizeBaseUrl(cfg.searxngBaseUrl)
    if (!baseUrl) throw new Error('Custom SearXNG URL is empty.')
    const probe = await probeSearxngAsync(baseUrl)
    if (probe.jsonOk) return getWebSearchStatusAsync(cfg)
    if (probe.reachable) {
      throw new Error(
        `SearXNG at ${baseUrl} is reachable, but its JSON API is not usable${probe.status ? ` (HTTP ${probe.status})` : ''}. ` +
        `The app needs the JSON format, but your browser only opens the HTML page. On that instance, in settings.yml enable:\n` +
        `  search:\n    formats:\n      - html\n      - json\n` +
        `then restart SearXNG. If a limiter/bot-detection is on, allow this client or disable the limiter.`,
      )
    }
    throw new Error(
      `Custom SearXNG is unreachable at ${baseUrl}${probe.error ? ` — ${probe.error}` : ''}. ` +
      `Check the URL and port, that the instance is running, and that a firewall/LAN is not blocking the connection from this machine.`,
    )
  }
  await ensureManagedSearxngAsync()
  return getWebSearchStatusAsync(cfg)
}

export async function getWebSearchStatusAsync(cfg: Pick<AppConfig, 'webSearchProvider' | 'searxngBaseUrl'>): Promise<WebSearchStatus> {
  const dockerOk = await dockerAvailableAsync()
  const customUrl = normalizeBaseUrl(cfg.searxngBaseUrl)

  if (cfg.webSearchProvider === 'disabled') {
    return { provider: 'disabled', dockerAvailable: dockerOk, customUrlConfigured: Boolean(customUrl), effectiveBaseUrl: null, healthy: false, detail: 'Web search disabled.' }
  }

  if (cfg.webSearchProvider === 'custom-searxng') {
    const probe = customUrl ? await probeSearxngAsync(customUrl) : null
    const healthy = Boolean(probe?.jsonOk)
    return {
      provider: 'custom-searxng',
      dockerAvailable: dockerOk,
      customUrlConfigured: Boolean(customUrl),
      effectiveBaseUrl: customUrl,
      healthy,
      detail: !customUrl
        ? 'Custom SearXNG mode selected but URL is empty.'
        : healthy
          ? 'Custom SearXNG URL is reachable and its JSON API works.'
          : probe?.reachable
            ? `Custom SearXNG at ${customUrl} is reachable, but its JSON API is disabled/blocked${probe.status ? ` (HTTP ${probe.status})` : ''}. Enable "search.formats: [html, json]" in settings.yml and restart it.`
            : `Custom SearXNG URL is configured but not reachable right now${probe?.error ? ` — ${probe.error}` : ''}.`,
    }
  }

  const running = (await inspectContainerStateAsync()) === 'running'
  const baseUrl = running ? managedBaseUrl() : null
  const healthy = baseUrl ? await healthcheckAsync(baseUrl) : false
  return {
    provider: 'managed-searxng',
    dockerAvailable: dockerOk,
    customUrlConfigured: Boolean(customUrl),
    effectiveBaseUrl: baseUrl,
    healthy,
    detail: !dockerOk
      ? 'Docker is not available for managed local SearXNG.'
      : healthy ? 'Managed local SearXNG is running.'
        : running ? 'Managed local SearXNG container is running but not healthy yet.'
          : 'Managed local SearXNG will auto-start on first web search.',
  }
}

export function resolveWebSearchBaseUrl(cfg: Pick<AppConfig, 'webSearchProvider' | 'searxngBaseUrl'>, autoStartManaged = false): string | null {
  if (cfg.webSearchProvider === 'custom-searxng') {
    return normalizeBaseUrl(cfg.searxngBaseUrl)
  }
  if (cfg.webSearchProvider === 'managed-searxng') {
    if (autoStartManaged) return ensureManagedSearxng()
    return inspectContainerState() === 'running' ? managedBaseUrl() : null
  }
  return null
}

export function shouldEnableWebSearchTool(cfg: Pick<AppConfig, 'webSearchProvider' | 'searxngBaseUrl'>): boolean {
  if (cfg.webSearchProvider === 'custom-searxng') {
    return Boolean(normalizeBaseUrl(cfg.searxngBaseUrl))
  }
  if (cfg.webSearchProvider === 'managed-searxng') {
    return dockerAvailable()
  }
  return false
}

export function getWebSearchStatus(cfg: Pick<AppConfig, 'webSearchProvider' | 'searxngBaseUrl'>): WebSearchStatus {
  const dockerOk = dockerAvailable()
  const customUrl = normalizeBaseUrl(cfg.searxngBaseUrl)

  if (cfg.webSearchProvider === 'disabled') {
    return {
      provider: 'disabled',
      dockerAvailable: dockerOk,
      customUrlConfigured: Boolean(customUrl),
      effectiveBaseUrl: null,
      healthy: false,
      detail: 'Web search disabled.',
    }
  }

  if (cfg.webSearchProvider === 'custom-searxng') {
    const healthy = Boolean(customUrl) && healthcheck(customUrl!)
    return {
      provider: 'custom-searxng',
      dockerAvailable: dockerOk,
      customUrlConfigured: Boolean(customUrl),
      effectiveBaseUrl: customUrl,
      healthy,
      detail: customUrl
        ? healthy
          ? 'Custom SearXNG URL is reachable.'
          : 'Custom SearXNG URL is configured but not reachable right now.'
        : 'Custom SearXNG mode selected but URL is empty.',
    }
  }

  const running = inspectContainerState() === 'running'
  const baseUrl = running ? managedBaseUrl() : null
  const healthy = baseUrl ? healthcheck(baseUrl) : false
  return {
    provider: 'managed-searxng',
    dockerAvailable: dockerOk,
    customUrlConfigured: Boolean(customUrl),
    effectiveBaseUrl: baseUrl,
    healthy,
    detail: !dockerOk
      ? 'Docker is not available for managed local SearXNG.'
      : healthy
        ? 'Managed local SearXNG is running.'
        : running
          ? 'Managed local SearXNG container is running but not healthy yet.'
          : 'Managed local SearXNG will auto-start on first web search.',
  }
}

export function loadWebSearchConfig(): Pick<AppConfig, 'webSearchProvider' | 'searxngBaseUrl'> {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf-8')) as Partial<AppConfig>
    return {
      webSearchProvider: raw.webSearchProvider ?? (raw.searxngBaseUrl ? 'custom-searxng' : 'disabled'),
      searxngBaseUrl: raw.searxngBaseUrl ?? null,
    }
  } catch {
    return {
      webSearchProvider: 'disabled',
      searxngBaseUrl: null,
    }
  }
}
