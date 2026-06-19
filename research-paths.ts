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

const RESEARCH_ARTIFACT_FILES = new Set([
  'run.json',
  'evidence.jsonl',
  'corpus.jsonl',
  'claims.jsonl',
  'plan.md',
  'quality-gates.json',
  'report.md',
  'evidence-report.md',
])

function stripResearchArtifactFile(relOrAbs: string): string {
  const normalized = relOrAbs.replace(/\\/g, '/').replace(/\/+$/, '')
  const base = path.posix.basename(normalized)
  if (RESEARCH_ARTIFACT_FILES.has(base)) return path.posix.dirname(normalized)
  return normalized
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

export function resolveResearchDir(workspace: string, outputDir?: string): string {
  const root = path.resolve(workspace)
  const raw = stripResearchArtifactFile(String(outputDir || '.research').normalize('NFKC'))
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
  const existingDir = safe.find((candidate) => {
    try { return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory() } catch { return false }
  })
  if (existingDir) return existingDir
  return safe[safe.length - 1] || fallback
}
