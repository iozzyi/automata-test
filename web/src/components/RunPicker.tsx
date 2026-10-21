// Open an earlier run: after a refresh the page no longer knows which run it
// was showing, but the simulator does (GET /runs).
import { useEffect, useState } from 'react'
import { listRuns } from '../lib/api'

export function RunPicker({
  currentRunId,
  refreshKey,
  onOpen,
}: {
  currentRunId: string | null
  /** Changes whenever the list may be out of date (a run started or moved on). */
  refreshKey: string
  onOpen: (runId: string) => void
}) {
  const [runs, setRuns] = useState<{ id: string; status: string }[] | null>(
    null,
  )

  useEffect(() => {
    let alive = true
    listRuns()
      .then((r) => alive && setRuns([...r].reverse())) // newest first
      .catch(() => alive && setRuns([]))
    return () => {
      alive = false
    }
  }, [refreshKey])

  if (!runs) return null
  if (runs.length === 0) {
    return (
      <select
        data-testid="recent-runs"
        disabled
        aria-label="Open a run"
        className="rounded border border-slate-200 bg-slate-50 px-1.5 py-1 text-sm text-slate-400"
      >
        <option>No earlier runs</option>
      </select>
    )
  }
  return (
    <label data-testid="recent-runs" className="text-sm text-slate-600">
      <span className="sr-only">Open a run</span>
      <select
        value={currentRunId ?? ''}
        onChange={(e) => e.target.value && onOpen(e.target.value)}
        className="rounded border border-slate-300 bg-white px-1.5 py-1 text-sm"
      >
        {currentRunId === null && <option value="">Open a recent run…</option>}
        {runs.map((r) => (
          <option key={r.id} value={r.id}>
            {r.id} · {r.status}
          </option>
        ))}
      </select>
    </label>
  )
}
