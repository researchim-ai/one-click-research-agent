export type QueryClass = 'academic' | 'web' | 'code' | 'biology' | 'finance' | 'news' | 'general'

export interface RouterDecision {
  classes: QueryClass[]
  sources: string[]
}

const ACADEMIC_HINTS = /(paper|papers|arxiv|preprint|proceedings|journal|citation|doi|abstract|ablation|benchmark|survey|meta-analysis|статья|статьи|статей|препринт|журнал|публикация)/i
const NEWS_HINTS = /(news|latest|today|breaking|release|announcement|новост|выпуск|сегодня|свеж)/i
const CODE_HINTS = /(github|repository|repo|implementation|open source|open-source|code|sdk|api|library|framework|репозиторий|реализация|код)/i
const BIO_HINTS = /(biology|biotech|protein|gene|genom|cell|disease|drug|clinical|pubmed|биолог|белок|ген|клетк)/i
const FINANCE_HINTS = /(finance|stock|market|equity|crypto|trading|hedge|quant|фондов|фин|валют|криптовалют|трейдинг)/i

export function classifyQuery(query: string): RouterDecision {
  const q = String(query || '').toLowerCase()
  const classes: QueryClass[] = []

  if (ACADEMIC_HINTS.test(q)) classes.push('academic')
  if (CODE_HINTS.test(q)) classes.push('code')
  if (BIO_HINTS.test(q)) classes.push('biology')
  if (FINANCE_HINTS.test(q)) classes.push('finance')
  if (NEWS_HINTS.test(q)) classes.push('news')
  if (classes.length === 0) classes.push('general')

  const sources = new Set<string>()
  if (classes.includes('academic')) {
    sources.add('search_arxiv')
    sources.add('search_openalex')
    sources.add('search_huggingface_papers')
  }
  if (classes.includes('biology')) {
    sources.add('search_pubmed')
    sources.add('search_openalex')
  }
  if (classes.includes('code') || classes.includes('general') || classes.includes('news')) {
    sources.add('search_web')
  }
  if (classes.includes('finance') || classes.includes('news')) {
    sources.add('search_web')
  }
  if (sources.size === 0) {
    sources.add('search_web')
    sources.add('search_openalex')
  }
  return { classes, sources: [...sources] }
}
