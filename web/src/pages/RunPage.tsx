// Provided. Wires the socket and the snapshot into your run state, and renders
// what the selectors report. It holds no run logic of its own.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Banner } from '../components/Banner'
import { Timeline } from '../pages/Timeline'
import { createRun, fetchSnapshot, startRun } from '../lib/api'
import { connect } from '../lib/socket'
import {
  applyMessage,
  applySnapshot,
  applyTransport,
  createRunState,
  selectConnection,
  selectResumeFrom,
  selectRunStatus,
  selectTracks,
} from '../lib/runState'
import type { RunState } from '../lib/runState'

export function RunPage() {
  const [state, setState] = useState<RunState>(createRunState)
  const [runId, setRunId] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
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
    setRunId(id)
    await startRun(id)
  }, [])

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

      <Timeline tracks={tracks} now={now} t0={t0} />
    </div>
  )
}
