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

export async function fetchSnapshot(id: string): Promise<Snapshot> {
  const r = await fetch(`${BASE}/runs/${id}`)
  return (await r.json()) as Snapshot
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
