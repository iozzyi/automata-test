// Every failure someone has to act on, between the banner and the timeline.
// Rendered only while there is something to act on.
import type { FailureView } from '../lib/runState'
import { FailureCard } from './FailureCard'

export function NeedsAttention({
  failures,
  runId,
  onRetry,
  onShow,
}: {
  failures: FailureView[]
  runId: string | null
  onRetry: (stepId: string, attempt: number) => void
  onShow: (stepId: string, attempt: number) => void
}) {
  if (failures.length === 0) return null
  return (
    <section
      data-testid="needs-attention"
      aria-label="Needs attention"
      className="space-y-2"
    >
      <h2 className="text-sm font-semibold text-slate-900">
        Needs attention ({failures.length})
      </h2>
      {failures.map((f) => (
        <FailureCard
          key={`${f.attempt.stepId}#${f.attempt.attempt}`}
          view={f}
          runId={runId}
          onRetry={onRetry}
          onShow={onShow}
        />
      ))}
    </section>
  )
}
