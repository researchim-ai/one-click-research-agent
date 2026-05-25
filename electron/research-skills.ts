import * as fs from 'fs'
import * as path from 'path'
import { getResearchProfileByPresetId } from '../research-profiles'

export interface ResearchSkill {
  id: string
  name: string
  domain: string
  description: string
  triggers: string[]
  requiredTools: string[]
  prompt: string
}

export const BUILTIN_RESEARCH_SKILLS: ResearchSkill[] = [
  {
    id: 'literature-review',
    name: 'Literature Review',
    domain: 'general',
    description: 'Plan, search, screen, compare, synthesize and report a literature review.',
    triggers: ['literature', 'survey', 'state of the art', 'обзор', 'литература'],
    requiredTools: ['plan_research', 'build_corpus', 'get_citations', 'record_evidence', 'reflect', 'run_quality_gates'],
    prompt: 'Use a staged literature review: define scope, build corpus, dedupe/rank sources, read full text for primary papers, record claim-level evidence, reflect on gaps, then verify claims before reporting.',
  },
  {
    id: 'evidence-synthesis',
    name: 'Evidence Synthesis',
    domain: 'general',
    description: 'Turn sources into claim-evidence rows and contradiction-aware synthesis.',
    triggers: ['evidence', 'claims', 'contradictions', 'доказательства', 'противоречия'],
    requiredTools: ['record_evidence', 'evidence_matrix', 'verify_claims', 'reflect'],
    prompt: 'For each important conclusion, record a claim with supporting source ids, quote if available, confidence, and support type. Treat unsupported claims as hypotheses.',
  },
  {
    id: 'source-verification',
    name: 'Source Verification',
    domain: 'general',
    description: 'Check URLs, citation references and report readiness.',
    triggers: ['verify', 'citations', 'sources', 'проверь источники'],
    requiredTools: ['verify_sources', 'verify_claims', 'run_quality_gates'],
    prompt: 'Before final output, verify live sources, check that citation ids exist, and list unverified claims or stale sources explicitly.',
  },
  {
    id: 'paper-reproduction',
    name: 'Paper Reproduction',
    domain: 'reproducibility',
    description: 'Map claims to code/data/assets and produce an executable reproduction checklist.',
    triggers: ['reproduce', 'baseline', 'github', 'воспроизвед', 'репрод'],
    requiredTools: ['search_arxiv', 'search_web', 'fetch_url', 'parse_document', 'execute_command', 'plan_research'],
    prompt: 'Map target claims to required artifacts: paper, code, environment, data, weights and metrics. Run only approved commands and keep an experiment log.',
  },
  {
    id: 'biomedical-literature-review',
    name: 'Biomedical Literature Review',
    domain: 'biology',
    description: 'Screen biomedical papers with attention to study design, cohorts, protocols and limitations.',
    triggers: ['pubmed', 'clinical', 'protein', 'gene', 'biomed', 'био'],
    requiredTools: ['search_pubmed', 'search_openalex', 'fetch_url', 'parse_document', 'record_evidence'],
    prompt: 'Use biomedical caution: capture study type, cohort/sample, controls, endpoints, limitations, and whether claims are clinical, preclinical or mechanistic.',
  },
  {
    id: 'proof-map',
    name: 'Proof Map',
    domain: 'mathematics',
    description: 'Decompose definitions, assumptions, lemmas, theorem statements and proof gaps.',
    triggers: ['proof', 'theorem', 'lemma', 'доказательство', 'теорема'],
    requiredTools: ['search_arxiv', 'parse_document', 'reflect', 'record_evidence'],
    prompt: 'Build a proof map: definitions, assumptions, lemmas, dependencies, proof skeleton and unresolved steps. Do not treat intuition as proof.',
  },
  {
    id: 'financial-memo',
    name: 'Financial Memo',
    domain: 'finance',
    description: 'Prepare risk-aware finance/economics memos with primary-source traceability.',
    triggers: ['finance', 'market', 'stock', 'sec', 'эконом', 'финанс'],
    requiredTools: ['search_web', 'fetch_url', 'parse_document', 'verify_sources'],
    prompt: 'Separate data from interpretation, include data dates, cite primary filings/data sources, and never present conclusions as guaranteed financial advice.',
  },
]

function customSkillsDir(workspace: string): string {
  return path.join(workspace, '.research', 'skills')
}

function parseCustomSkill(filePath: string): ResearchSkill | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const id = path.basename(filePath, path.extname(filePath))
    const title = raw.match(/^#\s+(.+)$/m)?.[1]?.trim() || id
    const desc = raw.match(/^description:\s*(.+)$/mi)?.[1]?.trim() || raw.split('\n').slice(0, 5).join(' ').slice(0, 180)
    const tools = raw.match(/^tools:\s*(.+)$/mi)?.[1]?.split(',').map((s) => s.trim()).filter(Boolean) || []
    const domain = raw.match(/^domain:\s*(.+)$/mi)?.[1]?.trim() || 'custom'
    return { id, name: title, domain, description: desc, triggers: [id, title], requiredTools: tools, prompt: raw }
  } catch { return null }
}

export function listResearchSkills(workspace?: string): ResearchSkill[] {
  const skills = [...BUILTIN_RESEARCH_SKILLS]
  if (workspace) {
    const dir = customSkillsDir(workspace)
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.endsWith('.md')) continue
        const skill = parseCustomSkill(path.join(dir, entry))
        if (skill) skills.push(skill)
      }
    } catch {}
  }
  return skills
}

export function skillPackForPreset(presetId: string | null | undefined): string {
  const profile = getResearchProfileByPresetId(presetId)
  const skills = listResearchSkills().filter((skill) => profile.defaultSkills.includes(skill.id))
  if (skills.length === 0) return ''
  return [
    '## Profile Skills (load just-in-time when relevant)',
    ...skills.map((s) => `- ${s.id}: ${s.description}. Tools: ${s.requiredTools.join(', ')}`),
    'Call `load_research_skill` when you need the full workflow instructions for a skill.',
  ].join('\n')
}

export function loadResearchSkill(id: string, workspace?: string): string {
  const skill = listResearchSkills(workspace).find((s) => s.id === id || s.name.toLowerCase() === String(id).toLowerCase())
  if (!skill) return `Error: research skill "${id}" not found.`
  return [
    `# Skill: ${skill.name}`,
    `Domain: ${skill.domain}`,
    `Description: ${skill.description}`,
    `Required tools: ${skill.requiredTools.join(', ') || 'none'}`,
    '',
    skill.prompt,
  ].join('\n')
}

export function recommendSkills(query: string, presetId?: string | null, workspace?: string): ResearchSkill[] {
  const q = String(query || '').toLowerCase()
  const profile = getResearchProfileByPresetId(presetId)
  return listResearchSkills(workspace)
    .filter((skill) => profile.defaultSkills.includes(skill.id) || skill.triggers.some((t) => q.includes(t.toLowerCase())))
    .slice(0, 6)
}
