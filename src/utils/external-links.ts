export function normalizeExternalHttpUrl(raw: string | null | undefined): string | null {
  const value = String(raw ?? '').trim()
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString()
  } catch {
    return null
  }
}

const URL_REGEX = /(https?:\/\/[^\s<>()]+[^\s<>().,!?;:])/g

export function splitTextByUrls(text: string): Array<{ type: 'text' | 'url'; value: string }> {
  const segments: Array<{ type: 'text' | 'url'; value: string }> = []
  let lastIndex = 0

  for (const match of text.matchAll(URL_REGEX)) {
    const index = match.index ?? 0
    const value = match[0]
    if (index > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, index) })
    }
    segments.push({ type: 'url', value })
    lastIndex = index + value.length
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) })
  }

  return segments.length > 0 ? segments : [{ type: 'text', value: text }]
}
