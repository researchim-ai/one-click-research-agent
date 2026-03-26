import { spawnSync } from 'child_process'
import path from 'path'

export interface GitFileStatus {
  /** Path relative to repo root (forward slashes) */
  path: string
  /** X Y from porcelain: M=modified, A=added, D=deleted, U=unmerged, ?=untracked, etc. */
  status: string
}

export interface GitStatus {
  branch: string | null
  /** List of changed files; empty if not a repo or error */
  files: GitFileStatus[]
  isRepo: boolean
}

const sep = path.sep

/**
 * Normalize path to forward slashes for consistent comparison with workspace paths.
 */
function normalizeRelPath(p: string): string {
  return p.split(sep).filter(Boolean).join('/')
}

/**
 * Get git status for the given workspace directory.
 * Runs `git status --porcelain -b` and parses output.
 */
export function getStatus(workspace: string): GitStatus {
  if (!workspace?.trim()) {
    return { branch: null, files: [], isRepo: false }
  }

  const result = spawnSync('git', ['status', '--porcelain', '-b'], {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 10000,
  })

  if (result.error || result.status !== 0) {
    return { branch: null, files: [], isRepo: false }
  }

  const out = (result.stdout || '').trim()
  const lines = out ? out.split('\n') : []
  let branch: string | null = null
  const files: GitFileStatus[] = []

  for (const line of lines) {
    if (line.startsWith('## ')) {
      const match = line.slice(3).match(/^([^\s.]+)/)
      if (match) branch = match[1]
      continue
    }
    if (line.length >= 4) {
      const xy = line.slice(0, 2)
      let filePath = line.slice(3).replace(/^"[^"]*"|^'[^']*'/, (m) => m.slice(1, -1)).trim()
      if (filePath.includes(' -> ')) filePath = filePath.split(' -> ')[1]?.trim() || filePath
      if (filePath) {
        files.push({
          path: normalizeRelPath(filePath),
          status: xy,
        })
      }
    }
  }

  return {
    branch,
    files,
    isRepo: true,
  }
}

export interface GitNumstatEntry {
  path: string
  added: number
  deleted: number
}

/**
 * Get added/deleted line counts per file (for diff stats in UI).
 * Runs `git diff --numstat HEAD` and parses output.
 */
export function getNumstat(workspace: string): GitNumstatEntry[] {
  if (!workspace?.trim()) return []

  const result = spawnSync('git', ['diff', '--numstat', 'HEAD'], {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 15000,
  })

  if (result.error || result.status !== 0) return []

  const lines = (result.stdout || '').trim().split('\n')
  const entries: GitNumstatEntry[] = []
  for (const line of lines) {
    const parts = line.split(/\s+/)
    if (parts.length >= 3) {
      const added = parseInt(parts[0], 10) || 0
      const deleted = parseInt(parts[1], 10) || 0
      let filePath = parts.slice(2).join(' ').trim()
      if (filePath.includes(' -> ')) filePath = filePath.split(' -> ')[1]?.trim() || filePath
      if (filePath) entries.push({ path: normalizeRelPath(filePath), added, deleted })
    }
  }
  return entries
}

/**
 * Get file content from HEAD (for diff view: original version).
 * Returns null if file is new (untracked) or error.
 */
export function getFileContentAtHead(workspace: string, relativePath: string): string | null {
  if (!workspace?.trim() || !relativePath?.trim()) return null

  const normalized = relativePath.split(path.sep).filter(Boolean).join('/')
  const result = spawnSync('git', ['show', `HEAD:${normalized}`], {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 10000,
  })

  if (result.error || result.status !== 0) return null
  return result.stdout ?? null
}
