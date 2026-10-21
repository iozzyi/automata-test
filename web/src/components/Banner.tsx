// Provided. Renders nothing while the connection is live.
import type { Connection } from '../lib/runState'

const TONE: Record<string, string> = {
  connecting: 'bg-slate-100 text-slate-700 border-slate-300',
  live: '',
  stale: 'bg-amber-50 text-amber-900 border-amber-300',
  gap: 'bg-rose-50 text-rose-900 border-rose-300',
}

const DEFAULT_NOTE: Record<string, string> = {
  connecting: 'Connecting to the run.',
  stale: 'Disconnected. This screen is not being updated.',
  gap: 'Reconnected, but part of this run was not recorded.',
}

export function Banner({ connection }: { connection: Connection }) {
  if (connection.status === 'live') return null
  return (
    <div
      data-testid="connection-banner"
      data-status={connection.status}
      className={`border rounded px-3 py-2 text-sm ${TONE[connection.status] ?? ''}`}
    >
      {connection.note ?? DEFAULT_NOTE[connection.status]}
    </div>
  )
}
