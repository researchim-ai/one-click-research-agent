import type { ResearchPresetId } from './research-presets'

export type ResearchProfileId =
  | 'universal'
  | 'ml-ai'
  | 'biology'
  | 'mathematics'
  | 'finance'
  | 'paper-reproduction'

export interface DomainConnector {
  id: string
  label: string
  description: string
  preferredTools: string[]
  status: 'available' | 'planned' | 'external'
}

export interface ResearchProfile {
  id: ResearchProfileId
  presetIds: ResearchPresetId[]
  label: string
  domain: string
  description: string
  preferredTools: string[]
  sourceConnectors: DomainConnector[]
  defaultSkills: string[]
  reportTemplates: string[]
  verificationRubric: string[]
  defaultWorkflow: string[]
  uiDefaults: {
    mode: 'quick' | 'deep' | 'systematic' | 'reproduction' | 'monitoring'
    maxSources: number
    preferFullText: boolean
    requireVerification: boolean
  }
}

export const RESEARCH_PROFILES: ResearchProfile[] = [
  {
    id: 'universal',
    presetIds: ['universal', 'deep-research'],
    label: 'Общий / General (web)',
    domain: 'general',
    description: 'Общий профиль для любых (в т.ч. ненаучных) тем: web-поиск, новости, документы, репозитории. Веб-первичен; академические гейты (обзоры/свежесть) не обязательны.',
    preferredTools: ['smart_search', 'search_web', 'fetch_url', 'plan_research', 'reflect', 'verify_sources', 'record_evidence', 'run_quality_gates'],
    sourceConnectors: [
      { id: 'searxng', label: 'SearXNG', description: 'Широкий web search по сайтам, новостям, docs и репозиториям — основной источник для общих тем.', preferredTools: ['search_web'], status: 'available' },
      { id: 'openalex', label: 'OpenAlex', description: 'Общий академический граф и metadata (опционально, если тема пересекается с наукой).', preferredTools: ['search_openalex'], status: 'available' },
      { id: 'crossref', label: 'Crossref', description: 'DOI-grade bibliographic metadata (опционально).', preferredTools: ['search_crossref'], status: 'available' },
    ],
    defaultSkills: ['literature-review', 'evidence-synthesis', 'source-verification'],
    reportTemplates: ['research-brief', 'evidence-matrix', 'state-of-the-art-map'],
    verificationRubric: ['source coverage', 'citation support', 'recency', 'contradictions', 'open questions'],
    defaultWorkflow: ['clarify', 'plan', 'search', 'read', 'record evidence', 'reflect', 'verify', 'report'],
    uiDefaults: { mode: 'deep', maxSources: 30, preferFullText: true, requireVerification: true },
  },
  {
    id: 'ml-ai',
    presetIds: ['ml-ai', 'arxiv-papers', 'opensource-analysis'],
    label: 'ML/AI Research',
    domain: 'machine-learning',
    description: 'Профиль для ML papers, benchmarks, repos, models, datasets и reproducibility.',
    preferredTools: ['search_arxiv', 'search_huggingface_papers', 'search_openalex', 'search_web', 'fetch_url', 'build_corpus', 'get_citations'],
    sourceConnectors: [
      { id: 'arxiv', label: 'arXiv', description: 'Preprints and technical papers.', preferredTools: ['search_arxiv', 'download_arxiv_html'], status: 'available' },
      { id: 'hf-papers', label: 'Hugging Face Papers', description: 'Paper pages, repos, model/project links.', preferredTools: ['search_huggingface_papers'], status: 'available' },
      { id: 'papers-with-code', label: 'Papers With Code', description: 'Benchmarks, code links, leaderboards.', preferredTools: ['search_web'], status: 'planned' },
      { id: 'openreview', label: 'OpenReview', description: 'Conference reviews and accepted papers.', preferredTools: ['search_web'], status: 'planned' },
      { id: 'github', label: 'GitHub', description: 'Official and community implementations.', preferredTools: ['search_web'], status: 'external' },
    ],
    defaultSkills: ['literature-review', 'benchmark-comparison', 'paper-reproduction'],
    reportTemplates: ['state-of-the-art-map', 'benchmark-audit', 'reproduction-plan'],
    verificationRubric: ['paper recency', 'benchmark validity', 'code availability', 'dataset availability', 'claim support'],
    defaultWorkflow: ['search papers', 'rank by relevance/citations/recency', 'find code', 'read full text', 'compare metrics', 'verify claims'],
    uiDefaults: { mode: 'systematic', maxSources: 40, preferFullText: true, requireVerification: true },
  },
  {
    id: 'biology',
    presetIds: ['biology'],
    label: 'Biology / Biomedicine',
    domain: 'biology',
    description: 'Профиль для biomedical literature, protocols, datasets, genes/proteins, trials и evidence quality.',
    preferredTools: ['search_pubmed', 'search_openalex', 'search_crossref', 'smart_search', 'fetch_url', 'parse_document', 'record_evidence'],
    sourceConnectors: [
      { id: 'pubmed', label: 'PubMed / Europe PMC', description: 'Biomedical literature and abstracts.', preferredTools: ['search_pubmed'], status: 'available' },
      { id: 'pmc-fulltext', label: 'PMC full text', description: 'Open-access biomedical full text.', preferredTools: ['fetch_url'], status: 'planned' },
      { id: 'biorxiv-medrxiv', label: 'bioRxiv / medRxiv', description: 'Life-science and clinical preprints.', preferredTools: ['search_web'], status: 'planned' },
      { id: 'clinicaltrials', label: 'ClinicalTrials.gov', description: 'Trials, interventions, outcomes.', preferredTools: ['search_web'], status: 'planned' },
      { id: 'pdb-uniprot', label: 'PDB / UniProt', description: 'Protein structures and annotations.', preferredTools: ['search_web'], status: 'planned' },
      { id: 'geo-sra', label: 'NCBI GEO / SRA', description: 'Omics datasets and runs.', preferredTools: ['search_web'], status: 'planned' },
    ],
    defaultSkills: ['biomedical-literature-review', 'protocol-analysis', 'evidence-synthesis'],
    reportTemplates: ['systematic-review', 'experimental-protocol', 'dataset-audit'],
    verificationRubric: ['study design', 'sample size', 'controls', 'clinical relevance', 'limitations', 'source support'],
    defaultWorkflow: ['define PICO/problem', 'search PubMed/OpenAlex', 'screen studies', 'extract evidence', 'check limitations', 'verify sources'],
    uiDefaults: { mode: 'systematic', maxSources: 50, preferFullText: true, requireVerification: true },
  },
  {
    id: 'mathematics',
    presetIds: ['mathematics'],
    label: 'Mathematics',
    domain: 'mathematics',
    description: 'Профиль для теорем, proof maps, assumptions, lemmas, derivations и формальной проверки.',
    preferredTools: ['search_arxiv', 'search_semantic_scholar', 'search_crossref', 'fetch_url', 'parse_document', 'reflect'],
    sourceConnectors: [
      { id: 'arxiv-math', label: 'arXiv math categories', description: 'Mathematical preprints and surveys.', preferredTools: ['search_arxiv'], status: 'available' },
      { id: 'openalex-math', label: 'OpenAlex math metadata', description: 'Published math works and citation graph.', preferredTools: ['search_openalex'], status: 'available' },
      { id: 'zbmath', label: 'zbMATH', description: 'Specialized mathematical bibliographic records.', preferredTools: ['search_web'], status: 'planned' },
      { id: 'lean', label: 'Lean projects', description: 'Optional formal proof projects in local workspaces.', preferredTools: ['execute_command', 'find_files'], status: 'external' },
    ],
    defaultSkills: ['proof-map', 'lemma-extraction', 'latex-analysis'],
    reportTemplates: ['theorem-map', 'proof-skeleton', 'assumption-audit'],
    verificationRubric: ['definitions', 'assumptions', 'logical dependencies', 'proof gaps', 'counterexamples'],
    defaultWorkflow: ['extract definitions', 'map lemmas', 'outline proof', 'stress-test steps', 'record reusable facts'],
    uiDefaults: { mode: 'deep', maxSources: 25, preferFullText: true, requireVerification: false },
  },
  {
    id: 'finance',
    presetIds: ['finance'],
    label: 'Finance / Economics',
    domain: 'finance',
    description: 'Профиль для filings, macro data, economics literature, market commentary и risk-aware synthesis.',
    preferredTools: ['search_web', 'search_openalex', 'search_crossref', 'fetch_url', 'parse_document', 'verify_sources'],
    sourceConnectors: [
      { id: 'sec-edgar', label: 'SEC EDGAR', description: 'Company filings and disclosures.', preferredTools: ['search_web', 'fetch_url'], status: 'planned' },
      { id: 'fred', label: 'FRED', description: 'US macroeconomic time series.', preferredTools: ['search_web'], status: 'planned' },
      { id: 'worldbank', label: 'World Bank', description: 'Global economic indicators.', preferredTools: ['search_web'], status: 'planned' },
      { id: 'imf-oecd', label: 'IMF / OECD', description: 'Macro reports and datasets.', preferredTools: ['search_web'], status: 'planned' },
      { id: 'academic-finance', label: 'Academic finance', description: 'Published papers and DOI metadata.', preferredTools: ['search_openalex', 'search_crossref'], status: 'available' },
    ],
    defaultSkills: ['financial-memo', 'risk-analysis', 'dataset-audit'],
    reportTemplates: ['finance-memo', 'risk-note', 'data-source-audit'],
    verificationRubric: ['source credibility', 'date of data', 'assumptions', 'risk caveats', 'not financial advice'],
    defaultWorkflow: ['collect primary sources', 'verify dates/numbers', 'separate facts from interpretation', 'identify risks', 'report cautiously'],
    uiDefaults: { mode: 'deep', maxSources: 30, preferFullText: true, requireVerification: true },
  },
  {
    id: 'paper-reproduction',
    presetIds: ['paper-reproduction'],
    label: 'Paper Reproduction',
    domain: 'reproducibility',
    description: 'Профиль для paper-to-code reproduction: paper, code, data, environment, baseline, logs and verdict.',
    preferredTools: ['search_arxiv', 'search_web', 'fetch_url', 'parse_document', 'execute_command', 'plan_research', 'export_report'],
    sourceConnectors: [
      { id: 'paper-source', label: 'Paper source', description: 'arXiv/DOI/PDF/HTML primary paper.', preferredTools: ['search_arxiv', 'fetch_url', 'parse_document'], status: 'available' },
      { id: 'code-source', label: 'Code source', description: 'Official GitHub/release/model repos.', preferredTools: ['search_web', 'fetch_url'], status: 'external' },
      { id: 'datasets', label: 'Datasets', description: 'Dataset pages, mirrors, checksums.', preferredTools: ['search_web', 'fetch_url'], status: 'external' },
    ],
    defaultSkills: ['paper-reproduction', 'experiment-log', 'dependency-audit'],
    reportTemplates: ['reproduction-plan', 'experiment-log', 'reproducibility-verdict'],
    verificationRubric: ['claim mapping', 'asset availability', 'environment reproducibility', 'baseline match', 'known blockers'],
    defaultWorkflow: ['map claims', 'find code/data', 'create checklist', 'run minimal baseline', 'record logs', 'write verdict'],
    uiDefaults: { mode: 'reproduction', maxSources: 25, preferFullText: true, requireVerification: true },
  },
]

export function getResearchProfileByPresetId(presetId: string | null | undefined): ResearchProfile {
  return RESEARCH_PROFILES.find((profile) => profile.presetIds.includes(presetId as ResearchPresetId))
    ?? RESEARCH_PROFILES[0]
}

export function formatResearchProfileForPrompt(profile: ResearchProfile): string {
  return [
    '## Active Research Profile',
    `- Profile: ${profile.label} (${profile.domain})`,
    `- Goal: ${profile.description}`,
    `- Preferred tools: ${profile.preferredTools.join(', ')}`,
    `- Default skills: ${profile.defaultSkills.join(', ')}`,
    `- Report templates: ${profile.reportTemplates.join(', ')}`,
    `- Verification rubric: ${profile.verificationRubric.join('; ')}`,
    `- Default workflow: ${profile.defaultWorkflow.join(' → ')}`,
    '',
    'Use this profile to choose sources, tools, report format, and quality checks. If a needed connector is only planned/external, explain the limitation and fall back to available tools.',
  ].join('\n')
}
