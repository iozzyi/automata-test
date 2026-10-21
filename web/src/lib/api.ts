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

export async function retryStep(
  runId: string,
  stepId: string,
): Promise<Response> {
  return fetch(`${BASE}/runs/${runId}/steps/${stepId}/retry`, {
    method: 'POST',
  })
}

export function wsURL(runId: string, resumeFrom: number): string {
  const base = BASE.replace(/^http/, 'ws')
  return `${base}/ws?run_id=${encodeURIComponent(runId)}&resume_from=${resumeFrom}`
}
