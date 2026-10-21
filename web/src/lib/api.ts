// Provided. Plain fetch against the simulator.
import type { Snapshot } from './types'

const BASE = import.meta.env.VITE_SIM_URL ?? 'http://localhost:5002'

export async function createRun(): Promise<string> {
  const r = await fetch(`${BASE}/runs`, { method: 'POST' })
  return (await r.json()).id as string
}

export async function startRun(id: string): Promise<void> {
  await fetch(`${BASE}/runs/${id}/start`, { method: 'POST' })
}

export async function listRuns(): Promise<{ id: string; status: string }[]> {
  const r = await fetch(`${BASE}/runs`)
  return (await r.json()).runs
}

/** Rejects unless the server answered with something shaped like a snapshot,
 *  so a 404 or an error page never reaches the state layer. */
export async function fetchSnapshot(id: string): Promise<Snapshot> {
  const r = await fetch(`${BASE}/runs/${encodeURIComponent(id)}`)
  if (!r.ok) throw new Error(`snapshot for ${id}: HTTP ${r.status}`)
  const body = (await r.json()) as Partial<Snapshot> | null
  if (
    typeof body?.seq !== 'number' ||
    typeof body.run?.id !== 'string' ||
    !Array.isArray(body.run.steps)
  ) {
    throw new Error(`snapshot for ${id}: unexpected shape`)
  }
  return body as Snapshot
}

/** 202 from the retry endpoint. Accepted, not done: only step.dispatched for
 *  `next_attempt` on the stream confirms it. */
export interface RetryAccepted {
  run_id: string
  step_id: string
  retrying_attempt: number
  next_attempt: number
  status: string
  /** True when this attempt had already been retried; nothing new started. */
  duplicate: boolean
  message: string
}

export type RetryResult =
  | { ok: true; status: number; body: RetryAccepted }
  | {
      ok: false
      /** HTTP status, or 0 when the server could not be reached. */
      status: number
      /** The server's machine-readable code, `NETWORK`, or `HTTP_<status>`. */
      code: string
      message: string
      body?: unknown
    }

/** Retry a failed attempt. Always pins the attempt, so a repeat (a double
 *  click, a retried request) is reported as a duplicate, not a second retry. */
/** The simulator's knobs, as GET /health and PUT /config report them. */
export interface SimConfig {
  fail_step: string
  reorder_pct: number
  duplicate_pct: number
  socket_kill_ms: number
  socket_reject_ms: number
  replay_buffer_size: number
}

export async function getConfig(): Promise<SimConfig> {
  const r = await fetch(`${BASE}/health`)
  if (!r.ok) throw new Error(`The simulator answered ${r.status}.`)
  return ((await r.json()) as { config: SimConfig }).config
}

/** Change the simulator's knobs. Testing only: see PUT /config. */
export async function setConfig(cfg: Partial<SimConfig>): Promise<SimConfig> {
  const r = await fetch(`${BASE}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  })
  const body = (await r.json().catch(() => ({}))) as {
    config?: SimConfig
    message?: string
  }
  if (!r.ok || !body.config) {
    throw new Error(body.message ?? `The simulator answered ${r.status}.`)
  }
  return body.config
}

/** Start over: stop and delete every run, put every knob back to clean.
 *  Testing only: see POST /reset. */
export async function resetSimulator(): Promise<SimConfig> {
  const r = await fetch(`${BASE}/reset`, { method: 'POST' })
  if (!r.ok) throw new Error(`The simulator answered ${r.status}.`)
  return ((await r.json()) as { config: SimConfig }).config
}

export async function retryStep(
  runId: string,
  stepId: string,
  attempt: number,
): Promise<RetryResult> {
  let r: Response
  try {
    r = await fetch(
      `${BASE}/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/retry`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attempt }),
      },
    )
  } catch {
    return {
      ok: false,
      status: 0,
      code: 'NETWORK',
      message:
        "Couldn't reach the lab server. Check the connection and try again.",
    }
  }
  const body: unknown = await r.json().catch(() => undefined)
  if (r.ok) return { ok: true, status: r.status, body: body as RetryAccepted }
  const err = (body ?? {}) as { code?: unknown; message?: unknown }
  return {
    ok: false,
    status: r.status,
    code: typeof err.code === 'string' ? err.code : `HTTP_${r.status}`,
    message:
      typeof err.message === 'string'
        ? err.message
        : `The lab server answered ${r.status}.`,
    body,
  }
}

export function wsURL(runId: string, resumeFrom: number): string {
  const base = BASE.replace(/^http/, 'ws')
  return `${base}/ws?run_id=${encodeURIComponent(runId)}&resume_from=${resumeFrom}`
}
