// Canonical catalogue of discovery/search sources the agent can use, shared by the
// renderer (New Research dialog) and the Electron main/worker (tool-list enforcement).
// A user may restrict a run to a subset (e.g. "only arXiv"); that whitelist is enforced
// deterministically by filtering the tool list the model receives — not just via prompts.

export interface SearchSourceMeta {
  id: string
  label: string
  /** True for scholarly indexes; false for general web. */
  academic: boolean
  descriptionRu: string
  descriptionEn: string
}

export const SEARCH_SOURCES: SearchSourceMeta[] = [
  { id: 'search_arxiv', label: 'arXiv', academic: true, descriptionRu: 'Препринты (CS, физика, математика). Точные даты, читаемый full text.', descriptionEn: 'Preprints (CS, physics, math). Precise dates, readable full text.' },
  { id: 'search_openalex', label: 'OpenAlex', academic: true, descriptionRu: 'Широкий научный индекс с цитированиями и OA-ссылками.', descriptionEn: 'Broad scholarly index with citations and OA links.' },
  { id: 'search_semantic_scholar', label: 'Semantic Scholar', academic: true, descriptionRu: 'Научный поиск с учётом цитирований.', descriptionEn: 'Citation-aware academic search.' },
  { id: 'search_crossref', label: 'Crossref', academic: true, descriptionRu: 'Метаданные DOI по издателям.', descriptionEn: 'DOI metadata across publishers.' },
  { id: 'search_pubmed', label: 'PubMed', academic: true, descriptionRu: 'Биомедицина и науки о жизни.', descriptionEn: 'Biomedical / life sciences.' },
  { id: 'search_biorxiv', label: 'bioRxiv', academic: true, descriptionRu: 'Препринты по биологии.', descriptionEn: 'Biology preprints.' },
  { id: 'search_huggingface_papers', label: 'Hugging Face Papers', academic: true, descriptionRu: 'Свежие ML/AI статьи с кодом и моделями.', descriptionEn: 'Trending ML/AI papers with code and models.' },
  { id: 'search_web', label: 'Web', academic: false, descriptionRu: 'Общий веб-поиск (нужен настроенный SearXNG).', descriptionEn: 'General web search (requires a configured SearXNG).' },
]

export const SEARCH_SOURCE_IDS: string[] = SEARCH_SOURCES.map((s) => s.id)
const SEARCH_SOURCE_ID_SET = new Set(SEARCH_SOURCE_IDS)

/** Router tool that fans out to several engines; it can reach engines outside a whitelist,
 *  so it is disabled whenever a source restriction is active. */
export const ROUTER_SEARCH_TOOL = 'smart_search'

export function isSearchSourceTool(name: string): boolean {
  return SEARCH_SOURCE_ID_SET.has(name)
}

export function searchSourceLabel(id: string): string {
  return SEARCH_SOURCES.find((s) => s.id === id)?.label ?? id
}

/**
 * Normalize an allowed-sources whitelist. Returns `null` when there is effectively NO
 * restriction (undefined/empty, or every known source selected). A non-null result is a
 * genuine subset that must be enforced. Unknown ids are dropped.
 */
export function normalizeAllowedSearchTools(list?: readonly string[] | null): string[] | null {
  if (!Array.isArray(list)) return null
  const valid = [...new Set(list.filter((x) => SEARCH_SOURCE_ID_SET.has(x)))]
  if (valid.length === 0) return null
  if (valid.length >= SEARCH_SOURCE_IDS.length) return null
  return valid
}

/**
 * Remove search tools not permitted by `policy` (null = allow all). Also drops the
 * multi-engine router under a restriction. Non-search tool names pass through untouched.
 */
export function filterToolNamesByPolicy(names: string[], policy?: readonly string[] | null): string[] {
  const p = normalizeAllowedSearchTools(policy)
  if (!p) return names
  const allow = new Set(p)
  return names.filter((n) => {
    if (n === ROUTER_SEARCH_TOOL) return false
    if (isSearchSourceTool(n)) return allow.has(n)
    return true
  })
}
