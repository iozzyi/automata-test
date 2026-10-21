// Whatever the instrument reported in `context`, every key, in the order sent.
// Nothing here knows about any particular instrument: labels are tidied by
// rule with the raw key beside them, and nested values are drawn as boxes.
import {
  errorJson,
  formatScalar,
  tidyLabel,
  valueKind,
} from '../lib/contextFormat'
import type { StepError } from '../lib/types'
import { CopyButton } from './CopyButton'

export function InstrumentDetails({ error }: { error: StepError }) {
  const entries = Object.entries(error.context ?? {})
  return (
    <details
      open
      data-testid="instrument-details"
      className="rounded border border-slate-200 bg-white"
    >
      <summary className="cursor-pointer px-3 py-1.5 text-xs font-medium text-slate-700">
        Instrument details
      </summary>
      <div className="space-y-2 px-3 pb-3">
        {entries.length > 0 ? (
          <Rows entries={entries} />
        ) : (
          <p className="text-xs text-slate-500">
            The instrument reported no further details.
          </p>
        )}
        <CopyButton
          text={errorJson(error)}
          label="Copy JSON"
          testId="copy-json"
        />
      </div>
    </details>
  )
}

function Rows({ entries }: { entries: [string, unknown][] }) {
  return (
    <dl className="grid grid-cols-[minmax(9rem,max-content)_1fr] gap-x-4 gap-y-1 text-sm">
      {entries.map(([key, value]) => (
        <Row key={key} label={tidyLabel(key)} rawKey={key} value={value} />
      ))}
    </dl>
  )
}

function Row({
  label,
  rawKey,
  value,
}: {
  label: string
  rawKey: string
  value: unknown
}) {
  return (
    <>
      <dt className="text-slate-600">
        {label}
        {rawKey && (
          <code className="ml-1 text-[10px] text-slate-400">{rawKey}</code>
        )}
      </dt>
      <dd className="min-w-0 break-words text-slate-900">
        <ContextValue value={value} />
      </dd>
    </>
  )
}

function ContextValue({ value }: { value: unknown }) {
  const kind = valueKind(value)
  if (kind === 'scalar') {
    return (
      <span className={typeof value === 'number' ? 'tabular-nums' : undefined}>
        {formatScalar(value)}
      </span>
    )
  }
  const entries: [string, unknown][] =
    kind === 'list'
      ? (value as unknown[]).map((v, i) => [String(i + 1), v])
      : Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) {
    return <span className="text-slate-500">(empty)</span>
  }
  return (
    <div className="rounded border border-slate-200 bg-slate-50 p-2">
      <dl className="grid grid-cols-[minmax(5rem,max-content)_1fr] gap-x-3 gap-y-1">
        {entries.map(([key, v]) =>
          kind === 'list' ? (
            <Row key={key} label={`${key}.`} rawKey="" value={v} />
          ) : (
            <Row key={key} label={tidyLabel(key)} rawKey={key} value={v} />
          ),
        )}
      </dl>
    </div>
  )
}
