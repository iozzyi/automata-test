// One attempt, for any bar the user clicks: including a failure that has since
// been retried, which no longer needs action but is still part of the record.
import { formatClock, serviceReport } from '../lib/contextFormat'
import type { AttemptDetail as Detail } from '../lib/runState'
import { Badge } from './Badge'
import { CopyButton } from './CopyButton'
import { InstrumentDetails } from './InstrumentDetails'

export function AttemptDetail({
  detail,
  runId,
  onClose,
}: {
  detail: Detail
  runId: string | null
  onClose: () => void
}) {
  const { attempt: a, supersededBy } = detail
  const e = a.error
  return (
    <section
      data-testid="attempt-detail"
      aria-label={`${a.stepId}, attempt ${a.attempt}`}
      className="space-y-2 rounded border border-slate-200 p-3"
    >
      <header className="flex items-center gap-2">
        <h2 className="font-semibold text-slate-900">
          {a.stepId} · attempt {a.attempt}
        </h2>
        <Badge tone={a.status}>{a.status}</Badge>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto text-xs text-slate-600 hover:underline"
        >
          Close
        </button>
      </header>

      {supersededBy !== null && (
        <p className="text-sm text-slate-700">
          Superseded by attempt #{supersededBy}. This failure no longer needs
          action.
        </p>
      )}

      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-slate-600">Instrument</dt>
        <dd>{a.deviceId}</dd>
        <dt className="text-slate-600">Started</dt>
        <dd>
          {a.startedAt === null
            ? 'not confirmed by the instrument'
            : formatClock(a.startedAt)}
        </dd>
        <dt className="text-slate-600">Ended</dt>
        <dd>
          {a.endedAt !== null
            ? formatClock(a.endedAt)
            : a.status === 'running'
              ? 'still running: no end reported'
              : 'not reported'}
        </dd>
        <dt className="text-slate-600">Waited for the instrument</dt>
        <dd>{a.refused ? 'Yes, it was busy at first' : 'No'}</dd>
      </dl>

      {e && (
        <div className="space-y-2">
          <p className="text-sm text-slate-900">
            {e.detail}{' '}
            <code className="ml-1 text-xs text-slate-500">{e.code}</code>
          </p>
          <InstrumentDetails error={e} />
          {!e.retryable && (
            <CopyButton
              text={serviceReport(runId, a)}
              label="Copy report for service"
              testId="copy-service-report"
            />
          )}
        </div>
      )}
    </section>
  )
}
