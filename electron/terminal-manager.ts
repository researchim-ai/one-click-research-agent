import os from 'os'
import { BrowserWindow } from 'electron'

let ptyModule: typeof import('node-pty') | null = null

function getPty() {
  if (!ptyModule) {
    ptyModule = require('node-pty')
  }
  return ptyModule!
}

interface ManagedTerminal {
  pty: import('node-pty').IPty
  id: string
}

const terminals = new Map<string, ManagedTerminal>()
let counter = 0

function defaultShell(): string {
  if (process.platform === 'win32') return 'powershell.exe'
  return process.env.SHELL || '/bin/bash'
}

export function create(cwd: string, win: BrowserWindow): string {
  const pty = getPty()
  const id = `term-${++counter}`
  const shell = defaultShell()

  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd,
    env: { ...process.env } as Record<string, string>,
  })

  ptyProcess.onData((data: string) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('terminal-data', id, data)
    }
  })

  ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('terminal-exit', id, exitCode)
    }
    terminals.delete(id)
  })

  terminals.set(id, { pty: ptyProcess, id })
  return id
}

export function write(id: string, data: string): void {
  const t = terminals.get(id)
  if (t) t.pty.write(data)
}

export function resize(id: string, cols: number, rows: number): void {
  const t = terminals.get(id)
  if (t) {
    try { t.pty.resize(cols, rows) } catch { /* ignore resize errors */ }
  }
}

export function kill(id: string): void {
  const t = terminals.get(id)
  if (t) {
    t.pty.kill()
    terminals.delete(id)
  }
}

export function killAll(): void {
  for (const [id, t] of terminals) {
    try { t.pty.kill() } catch { /* ignore */ }
    terminals.delete(id)
  }
}

export function getCwd(id: string): string | null {
  const t = terminals.get(id)
  if (!t) return null
  try {
    return (t.pty as any).process ?? null
  } catch {
    return null
  }
}
