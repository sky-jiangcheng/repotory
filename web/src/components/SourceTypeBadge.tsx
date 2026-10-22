import { useTranslation } from 'react-i18next'
import s from './SourceTypeBadge.module.css'

// The derived display bucket of a knowledge source (ADR-0022 决策 4). The
// server owns the mapping — it sends `source_type` on every note — so this
// component never re-derives it from the source string. A second mapping here
// is exactly how the settings page and the note card would drift apart.
export type SourceType = 'agent-import' | 'user-conversation' | 'project-extract' | 'manual'

// One tone per bucket, so the same colour means the same thing everywhere:
// blue = imported agent memory, green = extracted from the project, purple =
// a conversation. `manual` is deliberately absent: a hand-written note
// carries no provenance and stays unbadged, so it has no tone to pick.
const toneByType: Partial<Record<SourceType, string>> = {
  'agent-import': s.toneAgentImport,
  'user-conversation': s.toneConversation,
  'project-extract': s.toneProjectExtract,
}

export interface Props {
  // The server-derived bucket. An unknown or missing value renders nothing
  // rather than guessing — the source name is not a type.
  type?: string
  // The raw source name, shown as a tooltip so the user can still see WHICH
  // agent the note came from (claude vs codex vs hermes) behind the bucket.
  source?: string
}

export default function SourceTypeBadge({ type, source }: Props) {
  const { t } = useTranslation()
  if (!type || type === 'manual') return null
  const tone = toneByType[type as SourceType]
  if (!tone) return null
  const label = t(`settings.sourceTypes.${type}`, { defaultValue: source || type })
  return (
    <span className={`${s.badge} ${tone}`} title={source ? `${label} · ${source}` : label}>
      {label}
    </span>
  )
}
