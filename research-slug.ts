const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
}

const CONFUSABLES: Record<string, string> = {
  // Cyrillic homoglyphs that commonly sneak into Latin abbreviations.
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', х: 'x', у: 'y', к: 'k', м: 'm', т: 't', н: 'h', в: 'b',
}

export function canonicalResearchSlug(input: string, fallback = 'research'): string {
  const normalized = String(input || '')
    .normalize('NFKC')
    .toLowerCase()
    .split('')
    .map((ch) => {
      if (/[a-z0-9]/.test(ch)) return ch
      if (CONFUSABLES[ch]) return CONFUSABLES[ch]
      if (CYRILLIC_TO_LATIN[ch] !== undefined) return CYRILLIC_TO_LATIN[ch]
      return '-'
    })
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 64)
  return normalized || fallback
}

export function canonicalResearchOutputDir(outputDir?: string): string {
  const raw = String(outputDir || '.research')
    .normalize('NFKC')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
  const parts = raw.split('/').filter(Boolean)
  if (parts.length === 0) return '.research'
  const rootIndex = parts[0] === '.research' || parts[0] === 'research' ? 1 : 0
  const normalizedParts = parts.slice(rootIndex).map((segment) => {
    const stamp = segment.match(/^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})(?:[_-](.*))?$/)
    if (stamp) {
      const suffix = canonicalResearchSlug(stamp[2] || 'research')
      return `${stamp[1]}_${suffix}`
    }
    return canonicalResearchSlug(segment)
  })
  return ['.research', ...normalizedParts].join('/')
}

export function makeResearchRunDirFromTopic(topic: string, date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-') + '_' + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join('-')
  return canonicalResearchOutputDir(`.research/${stamp}_${canonicalResearchSlug(topic)}`)
}
