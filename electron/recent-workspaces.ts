import fs from 'fs'
import path from 'path'
import os from 'os'

const MAX_RECENT = 12
const FILE_NAME = 'recent-workspaces.json'

function filePath(): string {
  return path.join(os.homedir(), '.one-click-agent', FILE_NAME)
}

export function getRecentWorkspaces(): string[] {
  try {
    const raw = fs.readFileSync(filePath(), 'utf-8')
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.filter((p): p is string => typeof p === 'string' && p.length > 0).slice(0, MAX_RECENT)
  } catch {
    return []
  }
}

export function addRecentWorkspace(dir: string): void {
  if (!dir || !dir.trim()) return
  const normalized = path.normalize(dir).trim()
  if (!normalized) return
  let list = getRecentWorkspaces()
  list = [normalized, ...list.filter((p) => path.normalize(p) !== normalized)].slice(0, MAX_RECENT)
  const dirPath = path.dirname(filePath())
  fs.mkdirSync(dirPath, { recursive: true })
  fs.writeFileSync(filePath(), JSON.stringify(list, null, 0), 'utf-8')
}
