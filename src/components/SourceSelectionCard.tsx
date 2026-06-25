import { useEffect, useState } from 'react'
import type { CorpusSelectionPayload, CorpusSelectionItem } from '../../electron/types'

interface Props {
  payload: CorpusSelectionPayload
  workspace: string
  appLanguage?: 'ru' | 'en'
  onOpenLink?: (url: string) => void
}

/**
 * Non-blocking review panel for the screened corpus. The research run keeps going;
 * the user can uncheck sources to drop them or re-check to restore them. Each toggle
 * flips screeningStatus in corpus.jsonl via IPC, so later phases (full-text reads,
 * evidence) pick up the change automatically.
 */
export function SourceSelectionCard({ payload, workspace, appLanguage = 'ru', onOpenLink }: Props) {
  const L = appLanguage === 'ru'
  const [items, setItems] = useState<CorpusSelectionItem[]>(payload.items)
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const [collapsed, setCollapsed] = useState(false)

  // Merge in fresh server payloads (e.g. a re-screen) while keeping the user's view.
  useEffect(() => {
    setItems((prev) => {
      const prevById = new Map(prev.map((p) => [p.id, p]))
      return payload.items.map((it) => prevById.get(it.id) ?? it)
    })
  }, [payload])

  const selectedCount = items.filter((i) => i.included).length

  const toggle = async (item: CorpusSelectionItem) => {
    const next = !item.included
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, included: next } : i)))
    setPending((p) => ({ ...p, [item.id]: true }))
    try {
      const res = await window.api?.setResearchSourceIncluded(workspace, payload.outputDir, item.id, next)
      if (res && !res.ok) {
        setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, included: !next } : i)))
      }
    } catch {
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, included: !next } : i)))
    } finally {
      setPending((p) => {
        const { [item.id]: _, ...rest } = p
        return rest
      })
    }
  }

  return (
    <div className="my-2 rounded-lg border border-zinc-700/70 bg-[#0f141b] overflow-hidden">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-zinc-800/40 hover:bg-zinc-800/70 transition-colors cursor-pointer text-left"
      >
        <span className="text-sm">📚</span>
        <span className="text-[12px] font-medium text-zinc-200">
          {L ? 'Отобранные источники' : 'Selected sources'}
        </span>
        <span className="text-[11px] text-emerald-400 tabular-nums">
          {selectedCount}/{items.length}
        </span>
        <span className="ml-auto text-[10px] text-zinc-500">
          {collapsed ? (L ? 'показать' : 'show') : (L ? 'свернуть' : 'hide')}
        </span>
      </button>

      {!collapsed && (
        <>
          <div className="px-3 py-1.5 text-[10px] text-zinc-500 border-b border-zinc-800/60">
            {L
              ? 'Снимите галочку, чтобы исключить источник. Исследование продолжается автоматически.'
              : 'Uncheck to drop a source. Research keeps running automatically.'}
          </div>
          <div className="max-h-72 overflow-y-auto divide-y divide-zinc-800/40">
            {items.map((item) => (
              <label
                key={item.id}
                className={`flex items-start gap-2 px-3 py-2 cursor-pointer hover:bg-zinc-800/30 transition-colors ${
                  item.included ? '' : 'opacity-45'
                }`}
              >
                <input
                  type="checkbox"
                  checked={item.included}
                  disabled={!!pending[item.id]}
                  onChange={() => toggle(item)}
                  className="mt-0.5 accent-emerald-500 cursor-pointer"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] text-zinc-200 leading-snug">
                    {item.title}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5 text-[10px] text-zinc-500">
                    {item.year != null && <span>{item.year}</span>}
                    {item.publicationType && item.publicationType !== 'unknown' && (
                      <span className="px-1 rounded bg-zinc-800/80 text-zinc-400">{item.publicationType}</span>
                    )}
                    {item.subQuestions && item.subQuestions.length > 0 && (
                      <span className="text-zinc-600">{item.subQuestions.join(', ')}</span>
                    )}
                    {item.url && (
                      <button
                        onClick={(e) => {
                          e.preventDefault()
                          onOpenLink?.(item.url)
                        }}
                        className="text-blue-400/80 hover:text-blue-300 hover:underline cursor-pointer"
                      >
                        {L ? 'ссылка' : 'link'}
                      </button>
                    )}
                  </div>
                </div>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
