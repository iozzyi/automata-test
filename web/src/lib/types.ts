// Provided. The wire contract, as the simulator sends it.

export type EventType =
  | 'step.dispatched'
  | 'step.refused'
  | 'step.started'
  | 'step.finished'
  | 'step.failed'
  | 'run.blocked'
  | 'run.completed'

/**
 * What an instrument reports when a step goes wrong.
 *
 * `context` is open on purpose. Each instrument reports whatever it happens to
 * know, so the keys differ by device and by fault, and nothing enumerates them.
 */
export interface StepError {
  code: string
  instrument: string
  detail: string
  retryable: boolean
  context?: Record<string, unknown>
}

export interface LabEvent {
  seq: number
  run_id: string
  type: EventType
  step_id?: string
  attempt?: number
  device_id?: string
  at: string
  error?: StepError
}

export interface StepSnapshot {
  id: string
  device_id: string
  depends_on: string[] | null
  status: string
  attempt: number
  /** ISO-8601, or null when the instrument has not confirmed it. */
  started_at: string | null
  ended_at: string | null
  error: StepError | null
}

/** GET /runs/{id}. `seq` is the stream position this snapshot reflects. */
export interface Snapshot {
  seq: number
  run: { id: string; status: string; steps: StepSnapshot[] }
}

export const DEVICES = [
  'liquid-handler-1',
  'incubator-1',
  'plate-reader-1',
] as const
