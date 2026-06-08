import * as path from 'path'
import * as fs from 'fs'
export { canonicalResearchOutputDir, canonicalResearchSlug, makeResearchRunDirFromTopic } from './research-slug'
import { canonicalResearchOutputDir } from './research-slug'

function isInsideWorkspace(workspace: string, candidate: string): boolean {
  const root = path.resolve(workspace)
  const resolved = path.resolve(candidate)
  return resolved === root || resolved.startsWith(root + path.sep)
}

function hasResearchArtifacts(dir: string): boolean {
  return ['run.json', 'evidence.jsonl', 'corpus.jsonl', 'plan.md', 'quality-gates.json', 'report.md']
    .some((name) => fs.existsSync(path.join(dir, name)))
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

export function resolveResearchDir(workspace: string, outputDir?: string): string {
  const root = path.resolve(workspace)
  const raw = String(outputDir || '.research').normalize('NFKC')
  const fallback = path.join(workspace, '.research')
  const candidates: string[] = []

  if (path.isAbsolute(raw)) {
    const absolute = path.resolve(raw)
    if (!isInsideWorkspace(workspace, absolute)) return fallback
    candidates.push(absolute)
    const relFromRoot = path.relative(root, absolute).replace(/\\/g, '/')
    if (relFromRoot === '.research' || relFromRoot.startsWith('.research/')) {
      candidates.push(path.resolve(workspace, canonicalResearchOutputDir(relFromRoot)))
    }
  } else {
    const rawRel = raw.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
    if (rawRel) candidates.push(path.resolve(workspace, rawRel))
    candidates.push(path.resolve(workspace, canonicalResearchOutputDir(outputDir)))
  }

  const safe = unique(candidates).filter((candidate) => isInsideWorkspace(workspace, candidate))
  const existingWithArtifacts = safe.find((candidate) => fs.existsSync(candidate) && hasResearchArtifacts(candidate))
  if (existingWithArtifacts) return existingWithArtifacts
  const existingDir = safe.find((candidate) => fs.existsSync(candidate))
  if (existingDir) return existingDir
  return safe[safe.length - 1] || fallback
}
