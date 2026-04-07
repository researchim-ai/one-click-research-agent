import { execFileSync, execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AppConfig } from './config'
import type { WebSearchStatus } from './types'

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

function ensureManagedJsonApiEnabled(): void {
  const script = `
from pathlib import Path

path = Path('/etc/searxng/settings.yml')
lines = path.read_text().splitlines()
try:
    search_start = next(i for i, line in enumerate(lines) if line.strip() == 'search:')
except StopIteration:
    raise SystemExit('search section not found in settings.yml')

search_end = len(lines)
for i in range(search_start + 1, len(lines)):
    line = lines[i]
    if line and not line.startswith(' '):
        search_end = i
        break

try:
    formats_start = next(i for i in range(search_start + 1, search_end) if lines[i].strip() == 'formats:')
except StopIteration:
    raise SystemExit('search.formats block not found in settings.yml')

formats_end = formats_start + 1
while formats_end < search_end and lines[formats_end].startswith('    - '):
    formats_end += 1

replacement = ['  formats:', '    - html', '    - json']
updated_lines = lines[:formats_start] + replacement + lines[formats_end:]
if updated_lines != lines:
    path.write_text('\\n'.join(updated_lines) + '\\n')
    print('patched')
elif '    - json' in lines:
    print('ok')
else:
    raise SystemExit('failed to enable json format in settings.yml')
`
  const out = runDocker(['exec', MANAGED_SEARXNG_CONTAINER, 'python', '-c', script], 30000).trim()
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

export function ensureManagedSearxng(): string {
  if (!dockerAvailable()) {
    throw new Error('Docker is not available. Switch web search mode to "Existing SearXNG URL" or install Docker.')
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
    return baseUrl
  } catch {
    removeManagedContainer()
    createManagedContainer()
    ensureManagedJsonApiEnabled()
    const baseUrl = managedBaseUrl()
    waitForHealthy(baseUrl)
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
