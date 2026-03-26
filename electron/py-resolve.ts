/**
 * Resolve Python module to file path (for "go to definition" on import names).
 * Runs Python with workspace on sys.path and returns __file__ for the module.
 */
import { spawn } from 'child_process'
import path from 'path'

const PYTHON_NAMES = ['python3', 'python']

function findPython(): string | null {
  for (const name of PYTHON_NAMES) {
    try {
      const { execSync } = require('child_process')
      execSync(`${name} --version`, { stdio: 'pipe' })
      return name
    } catch {
      continue
    }
  }
  return null
}

let cachedPython: string | null | undefined = undefined

function getPython(): string | null {
  if (cachedPython === undefined) cachedPython = findPython()
  return cachedPython
}

/**
 * Resolve module name to file path. Uses: python -c "import sys; sys.path.insert(0, workspace); m = __import__(moduleName); print(getattr(m, '__file__', '') or '')"
 * Returns null if Python not found or module cannot be resolved.
 */
export function resolvePythonModule(workspacePath: string, moduleName: string): Promise<string | null> {
  const python = getPython()
  if (!python || !moduleName || !/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(moduleName)) {
    return Promise.resolve(null)
  }

  const code = `
import sys
import os
try:
  workspace = ${JSON.stringify(workspacePath.replace(/\\/g, '/'))}
  if workspace:
    sys.path.insert(0, workspace)
  mod_name = ${JSON.stringify(moduleName)}
  m = __import__(mod_name)
  f = getattr(m, '__file__', None)
  if f:
    print(os.path.normpath(os.path.abspath(f)))
except Exception:
  pass
`

  return new Promise((resolve) => {
    let done = false
    const finish = (result: string | null) => {
      if (done) return
      done = true
      resolve(result)
    }
    const child = spawn(python, ['-c', code], {
      cwd: workspacePath || undefined,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    })
    let out = ''
    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString() })
    child.stderr?.on('data', () => {})
    child.on('error', () => finish(null))
    const t = setTimeout(() => {
      try { child.kill('SIGTERM') } catch {}
      finish(null)
    }, 8000)
    child.on('close', (code) => {
      clearTimeout(t)
      const line = out.trim().split(/\r?\n/)[0]?.trim()
      if (code === 0 && line && path.isAbsolute(line)) finish(line)
      else finish(null)
    })
  })
}
