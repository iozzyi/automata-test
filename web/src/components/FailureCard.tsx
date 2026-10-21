// One failure that needs someone to act. What failed, where and when; the
// instrument's own explanation; what can be done about it; and everything the
// instrument reported. The card never claims the instrument is running again:
// it only reports what the server and the event stream have said.
import { formatClock, serviceReport } from '../lib/contextFormat'
import type { FailurePhase, FailureView } from '../lib/runState'
import { CopyButton } from './CopyButton'
import { InstrumentDetails } from './InstrumentDetails'

const STATUS_TEXT: Record<FailurePhase, string> = {
  idle: '',
  requested: 'Retry requested…',
  accepted: 'Accepted, waiting for the instrument.',
  queued: 'Queued: the instrument is busy with another step.',
  unconfirmed: "Not confirmed yet; this screen isn't receiving updates.",
  error: '',
  needs_service: '',
}

const IN_FLIGHT: FailurePhase[] = [
  'requested',
  'accepted',
  'queued',
  'unconfirmed',
]

export function FailureCard({
  view,
  runId,
  onRetry,
  onShow,
}: {
  view: FailureView
  runId: string | null
  onRetry: (stepId: string, attempt: number) => void
  onShow: (stepId: string, attempt: number) => void
}) {
  const { attempt: a, phase } = view
  const e = a.error
  const service = phase === 'needs_service'
  const headingId = `failure-${a.stepId}-${a.attempt}`

  return (
    <article
      data-testid="failure-card"
      data-step={a.stepId}
      data-attempt={a.attempt}
      data-phase={phase}
      aria-labelledby={headingId}
      className={`space-y-2 rounded border-l-4 p-3 ${
        service ? 'border-rose-500 bg-rose-50' : 'border-amber-500 bg-amber-50'
      }`}
    >
      <header className="flex flex-wrap items-baseline gap-x-2">
        <h3 id={headingId} className="font-semibold text-slate-900">
          <button
            type="button"
            onClick={() => onShow(a.stepId, a.attempt)}
            className="hover:underline"
            title="Show this attempt on the timeline"
          >
            {a.stepId} failed
          </button>
        </h3>
        <span className="text-xs text-slate-600">
          {e?.instrument ?? a.deviceId} · attempt {a.attempt} ·{' '}
          {formatClock(a.endedAt)}
        </span>
        <span
          className={`ml-auto rounded px-1.5 py-0.5 text-xs font-medium ${
            service
              ? 'bg-rose-200 text-rose-900'
              : 'bg-amber-200 text-amber-900'
          }`}
        >
          {service ? 'Needs service' : 'Can be retried'}
        </span>
      </header>

      {e ? (
        <p className="text-base text-slate-900">
          {e.detail}{' '}
          <code className="ml-1 text-xs text-slate-500">{e.code}</code>
        </p>
      ) : (
        <p className="text-sm text-slate-600">
          The instrument did not say why. Check it before retrying.
        </p>
      )}

      {service ? (
        <div className="space-y-1 text-sm text-rose-950">
          <p className="font-medium">
            Retrying won't help: this instrument will fail the same way until it
            is serviced.
          </p>
          {view.message && <p className="text-rose-900">{view.message}</p>}
          <p>
            The run can't finish until this is fixed. Completed steps are kept.
          </p>
          <CopyButton
            text={serviceReport(runId, a)}
            label="Copy report for service"
            testId="copy-service-report"
          />
        </div>
      ) : (
        <RetryAction view={view} onRetry={onRetry} />
      )}

      {e && <InstrumentDetails error={e} />}
    </article>
  )
}

function RetryAction({
  view,
  onRetry,
}: {
  view: FailureView
  onRetry: (stepId: string, attempt: number) => void
}) {
  const { attempt: a, phase } = view
  const busy = IN_FLIGHT.includes(phase)
  const status =
    phase === 'error'
      ? `The retry was not accepted: ${view.message ?? 'unknown error'}`
      : phase === 'queued' && view.retriedElsewhere
        ? 'Someone else requested a retry. Queued: the instrument is busy with another step.'
        : STATUS_TEXT[phase]

  return (
    <div className="space-y-1 text-sm">
      {phase === 'idle' && (
        <p className="text-slate-700">
          Check the instrument, then retry. Completed steps are kept.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="retry-button"
          disabled={busy}
          onClick={() => onRetry(a.stepId, a.attempt)}
          className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400"
        >
          {phase === 'error' ? 'Try again' : 'Retry step'}
        </button>
        <p
          data-testid="retry-status"
          aria-live="polite"
          className={
            phase === 'error' || phase === 'unconfirmed'
              ? 'text-rose-800'
              : 'text-slate-700'
          }
        >
          {status}
        </p>
      </div>
    </div>
  )
}
