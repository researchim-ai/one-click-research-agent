import { Fragment, memo, useMemo } from 'react'
import { normalizeExternalHttpUrl, splitTextByUrls } from '../utils/external-links'

interface Props {
  text: string
  externalLinksEnabled: boolean
  onOpenLink?: (url: string) => void
}

export const ExternalLinkText = memo(function ExternalLinkText({ text, externalLinksEnabled, onOpenLink }: Props) {
  const segments = useMemo(() => splitTextByUrls(text), [text])

  return (
    <>
      {segments.map((segment, index) => {
        if (segment.type !== 'url') {
          return <Fragment key={index}>{segment.value}</Fragment>
        }

        const safeUrl = normalizeExternalHttpUrl(segment.value)
        if (!safeUrl || !externalLinksEnabled) {
          return <Fragment key={index}>{segment.value}</Fragment>
        }

        return (
          <button
            key={index}
            type="button"
            onClick={() => onOpenLink?.(safeUrl)}
            className="underline decoration-blue-400/50 underline-offset-2 text-blue-300 hover:text-blue-200 cursor-pointer break-all"
            title={safeUrl}
          >
            {segment.value}
          </button>
        )
      })}
    </>
  )
})
