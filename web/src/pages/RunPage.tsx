// Provided. Wires the socket and the snapshot into your run state, and renders
// what the selectors report. It holds no run logic of its own.
import { useCallback, useEffect, useRef, useState } from 'react'
import { AttemptDetail } from '../components/AttemptDetail'
import { Banner } from '../components/Banner'
import { NeedsAttention } from '../components/NeedsAttention'
import { Timeline } from '../pages/Timeline'
import { createRun, fetchSnapshot, retryStep, startRun } from '../lib/api'
import { connect } from '../lib/socket'
import {
  applyMessage,
  applyRetryRequested,
  applyRetryResult,
  applySnapshot,
  applyTransport,
  createRunState,
  selectAttempt,
  selectConnection,
  selectFailures,
  selectResumeFrom,
  selectRunStatus,
  selectTracks,
} from '../lib/runState'
import type { RunState } from '../lib/runState'

export function RunPage() {
  const [state, setState] = useState<RunState>(createRunState)
  const [runId, setRunId] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [selected, setSelected] = useState<{
    stepId: string
    attempt: number
  } | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state

  // The clock a running bar is drawn against.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (!runId) return
    const alive = { current: true }
    let close: (() => void) | undefined
    void (async () => {
      // Snapshot first, then subscribe from where the snapshot sits. That is
      // what selectResumeFrom is for. Each run starts from a fresh state, so a
      // second run does not inherit the first one's bars.
      let fresh = createRunState()
      try {
        fresh = applySnapshot(fresh, await fetchSnapshot(runId))
      } catch {
        // No snapshot: connect from 0 and let the server say what it can serve.
      }
      if (!alive.current) return
      // The socket asks selectResumeFrom synchronously as it connects, before
      // React re-renders, so the ref has to hold the snapshot already.
      stateRef.current = fresh
      setState(fresh)
      close = connect(runId, {
        resumeFrom: () => selectResumeFrom(stateRef.current),
        onMessage: (msg) => setState((s) => applyMessage(s, msg)),
        onOpen: () => setState((s) => applyTransport(s, 'open')),
        onClose: () => setState((s) => applyTransport(s, 'closed')),
      })
    })()
    return () => {
      alive.current = false
      close?.()
    }
  }, [runId])

  const onStart = useCallback(async () => {
    const id = await createRun()
    setSelected(null)
    setRunId(id)
    await startRun(id)
  }, [])

  // The card says what was asked and what the server answered; the timeline
  // only moves when the events that follow arrive.
  const onRetry = useCallback(
    async (stepId: string, attempt: number) => {
      if (!runId) return
      setState((s) => applyRetryRequested(s, stepId, attempt, Date.now()))
      const result = await retryStep(runId, stepId, attempt)
      if (stateRef.current.runId !== runId) return // a newer run took over
      setState((s) => applyRetryResult(s, stepId, attempt, result, Date.now()))
    },
    [runId],
  )

  const onShow = useCallback((stepId: string, attempt: number) => {
    setSelected({ stepId, attempt })
  }, [])

  const failures = selectFailures(state, now)
  const detail = selected
    ? selectAttempt(state, selected.stepId, selected.attempt)
    : null

  const tracks = selectTracks(state)
  const t0 = tracks
    .flatMap((t) => t.attempts.map((a) => a.startedAt))
    .filter((v): v is number => v !== null)
    .reduce<number | null>(
      (min, v) => (min === null || v < min ? v : min),
      null,
    )

  return (
    <div className="mx-auto max-w-6xl p-6 space-y-4 font-sans">
      <header className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Lab run monitor</h1>
        <span data-testid="run-status" className="text-sm text-slate-600">
          {runId ? `${runId} — ${selectRunStatus(state)}` : 'no run'}
        </span>
        <button
          data-testid="start-run"
          onClick={onStart}
          className="ml-auto rounded bg-slate-900 px-3 py-1.5 text-sm text-white"
        >
          Start a run
        </button>
      </header>

      <Banner connection={selectConnection(state)} />

      <NeedsAttention
        failures={failures}
        runId={runId}
        onRetry={(stepId, attempt) => void onRetry(stepId, attempt)}
        onShow={onShow}
      />

      <Timeline
        tracks={tracks}
        now={now}
        t0={t0}
        selected={selected ? `${selected.stepId}#${selected.attempt}` : null}
        onSelect={onShow}
      />

      {detail && (
        <AttemptDetail
          detail={detail}
          runId={runId}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}
