// ---------------------------------------------------------------------------
// The state layer. See "Make the run honest" in README.md and
// docs/spec/design.md section 3.
// ---------------------------------------------------------------------------
//
// Everything the screen shows comes from here. Two sources feed it:
//
//   * a snapshot -- current state, and the stream position it reflects
//   * a stream of events, which can arrive late, twice, or out of order
//
// Every event is applied the moment it arrives, through a merge that cannot
// go backwards: an attempt's status only moves forward, and each field is set
// by exactly one event type, from that event's own `at`. So the result does not
// depend on arrival order, and a duplicate changes nothing.
//
// Missing sequence numbers are tracked rather than waited for. The resume
// position is the highest seq with nothing missing before it, so a reconnect
// asks for the holes again; a hole that stays open while HOLE_TOLERANCE later
// events arrive makes the screen stop claiming to be live.
//
// Plain TypeScript on purpose: no React in this file, so the tests call
// straight into it. Keep the exported signatures -- they do.
import { DEVICES } from './types'
import type { EventType, LabEvent, Snapshot, StepError } from './types'

export type AttemptStatus = 'dispatched' | 'running' | 'done' | 'failed'

/** One occupancy of one device by one step. */
export interface Attempt {
  stepId: string
  attempt: number
  deviceId: string
  status: AttemptStatus
  refused: boolean
  /** Epoch ms, or null while the instrument has not confirmed it started. */
  startedAt: number | null
  /** Epoch ms, or null while it is still running. Never guess this. */
  endedAt: number | null
  /** Why it failed, when it did. Null otherwise. */
  error: StepError | null
}

export interface Track {
  deviceId: string
  attempts: Attempt[]
}

export type ConnectionStatus = 'connecting' | 'live' | 'stale' | 'gap'

export interface Connection {
  status: ConnectionStatus
  /** Highest sequence number applied so far. */
  lastSeq: number
  /** Shown to the user when the status is not 'live'. */
  note?: string
}

/** A hole still open after this many later events is reported. Raised from 5
 *  so the reorder knob (which can hold an event back for several others) does
 *  not raise false alarms. See docs/spec/design.md, O1. */
export const HOLE_TOLERANCE = 10

export const NOTE_HOLE =
  'An update was lost in transit; this view may be incomplete.'
export const NOTE_CLOSED_AFTER_GAP =
  'Disconnected. Part of this run was also not recorded.'

/** Shape freely. The selectors are the contract, not this. */
export interface RunState {
  /** Learned from the snapshot, or failing that the first event. */
  runId: string | null
  runStatus: string
  /** Every attempt, derived from byKey. */
  attempts: Attempt[]
  /** Attempts keyed `${stepId}#${attempt}`. */
  byKey: Record<string, Attempt>
  /** Attempt keys a step.refused has named, whenever it arrived. */
  refused: Record<string, true>
  /** Seqs applied above `contiguous`. */
  seen: Record<number, true>
  /** Highest seq with nothing missing before it. */
  contiguous: number
  /** Events at or below this are already covered by the snapshot. */
  floor: number
  socket: 'connecting' | 'open' | 'closed'
  /** Set by a gap frame, and never cleared: that part of the run is gone. */
  gap: { from: number; earliest: number } | null
  /** Retries this screen asked for, keyed by the failed attempt's key. */
  retries: Record<string, RetryRequest>
  /** Same as `contiguous`; the name the starter used. */
  lastSeq: number
  connection: Connection
}

/** A retry this screen asked for, and what the server said. Only events move
 *  the timeline; this only changes what the failure card claims. */
export interface RetryRequest {
  stepId: string
  attempt: number
  phase: 'requested' | 'accepted' | 'error'
  requestedAt: number
  acceptedAt?: number
  code?: string
  message?: string
  /** The server answered 422: it will not retry this, whatever the event said. */
  notRetryable?: boolean
}

/** What came back from the retry endpoint. `RetryResult` in api.ts fits this;
 *  it is restated here so this file stays free of fetch and the environment. */
export type RetryOutcome =
  { ok: true } | { ok: false; status: number; code: string; message: string }

/** No event within this long of a 202, and the card stops claiming progress. */
export const RETRY_CONFIRM_MS = 10_000

export type FailurePhase =
  | 'idle'
  | 'requested'
  | 'accepted'
  | 'queued'
  | 'unconfirmed'
  | 'error'
  | 'needs_service'

/** One failure that needs someone to act. */
export interface FailureView {
  attempt: Attempt
  phase: FailurePhase
  /** Set by someone else's retry: a step.refused for the next attempt with no
   *  request from this screen. */
  retriedElsewhere: boolean
  /** The server's words, for 'error' and for a 422. */
  message?: string
}

export function createRunState(): RunState {
  return {
    runId: null,
    runStatus: 'unknown',
    attempts: [],
    byKey: {},
    refused: {},
    seen: {},
    contiguous: 0,
    floor: 0,
    socket: 'connecting',
    gap: null,
    retries: {},
    lastSeq: 0,
    connection: { status: 'connecting', lastSeq: 0 },
  }
}

/**
 * Fold in a snapshot.
 *
 * Merged with the same forward-only rules as events, so a snapshot older than
 * what is already applied cannot move anything backwards. Its seq says which
 * events it already accounts for: those are ignored from here on.
 */
export function applySnapshot(state: RunState, snap: Snapshot): RunState {
  let byKey = state.byKey
  for (const step of snap.run.steps) {
    const status = step.status as AttemptStatus
    if (!(status in STATUS_RANK) || step.attempt < 1) continue // not yet on an instrument
    const key = attemptKey(step.id, step.attempt)
    const ended = status === 'done' || status === 'failed'
    byKey = {
      ...byKey,
      [key]: mergeAttempt(byKey[key], state.refused[key] === true, {
        stepId: step.id,
        attempt: step.attempt,
        deviceId: step.device_id,
        status,
        refused: false,
        startedAt: parseAt(step.started_at),
        endedAt: ended ? parseAt(step.ended_at) : null,
        error: status === 'failed' ? step.error : null,
      }),
    }
  }

  const floor = Math.max(state.floor, snap.seq)
  const [contiguous, seen] = advance(
    Math.max(state.contiguous, floor),
    state.seen,
  )
  return finish({
    ...state,
    runId: snap.run.id,
    runStatus: laterRunStatus(state.runStatus, snap.run.status),
    byKey,
    floor,
    contiguous,
    seen,
  })
}

/**
 * Fold in one frame off the socket.
 *
 * The argument is `unknown` because not everything on the wire is a LabEvent.
 * A gap frame admits part of the run cannot be replayed; anything else that
 * is not a well-formed event is ignored.
 */
export function applyMessage(state: RunState, msg: unknown): RunState {
  if (isGapFrame(msg)) return applyGap(state, msg)
  if (isLabEvent(msg)) return applyEvent(state, msg)
  return state
}

/**
 * Fold in one already-typed event. applyMessage delegates here once it has
 * decided a frame is an event.
 */
export function applyEvent(state: RunState, e: LabEvent): RunState {
  if (e.seq <= state.contiguous || state.seen[e.seq]) return state // had it
  if (state.runId !== null && e.run_id !== state.runId) return state // not ours

  const [contiguous, seen] = advance(state.contiguous, {
    ...state.seen,
    [e.seq]: true,
  })
  let next: RunState = {
    ...state,
    runId: state.runId ?? e.run_id,
    contiguous,
    seen,
  }

  if (e.type === 'run.blocked') {
    next.runStatus = laterRunStatus(next.runStatus, 'blocked')
  } else if (e.type === 'run.completed') {
    next.runStatus = laterRunStatus(next.runStatus, 'completed')
  } else if (e.step_id !== undefined && e.attempt !== undefined) {
    next = applyStepEvent(next, e, e.step_id, e.attempt)
  }
  return finish(next)
}

/**
 * Fold in a transport change: the socket opened, or it went away.
 *
 * A closed socket does not change what the lab is doing, but it does change
 * what this screen can honestly claim to know.
 */
export function applyTransport(
  state: RunState,
  kind: 'open' | 'closed',
): RunState {
  return finish({ ...state, socket: kind })
}

/** One track per device, in DEVICES order. Overlapping attempts on one track
 *  are physically impossible -- an instrument does one thing at a time.
 *
 *  A device not in DEVICES still gets a track, after the known ones, so its
 *  attempts are not thrown away. */
export function selectTracks(state: RunState): Track[] {
  const byDevice = new Map<string, Attempt[]>(DEVICES.map((d) => [d, []]))
  const extra = new Set<string>()
  for (const a of state.attempts) {
    let list = byDevice.get(a.deviceId)
    if (!list) {
      list = []
      byDevice.set(a.deviceId, list)
      extra.add(a.deviceId)
    }
    list.push(a)
  }
  const order = [...DEVICES, ...[...extra].sort()]
  return order.map((deviceId) => ({
    deviceId,
    attempts: [...(byDevice.get(deviceId) ?? [])].sort(byTimeThenId),
  }))
}

export function selectRunStatus(state: RunState): string {
  return state.runStatus
}

export function selectConnection(state: RunState): Connection {
  return state.connection
}

/** What to ask the server to resume from on the next connection attempt.
 *  Not the highest seq seen: anything missing below it is asked for again. */
export function selectResumeFrom(state: RunState): number {
  return state.contiguous
}

export interface AttemptDetail {
  attempt: Attempt
  /** The next attempt of the same step, once one exists. */
  supersededBy: number | null
}

export function selectAttempt(
  state: RunState,
  stepId: string,
  attempt: number,
): AttemptDetail | null {
  const found = state.byKey[attemptKey(stepId, attempt)]
  if (!found) return null
  const next = state.byKey[attemptKey(stepId, attempt + 1)]
  return { attempt: found, supersededBy: next ? next.attempt : null }
}

/** The Retry button was pressed for this failed attempt. */
export function applyRetryRequested(
  state: RunState,
  stepId: string,
  attempt: number,
  now: number,
): RunState {
  const key = attemptKey(stepId, attempt)
  return {
    ...state,
    retries: {
      ...state.retries,
      [key]: { stepId, attempt, phase: 'requested', requestedAt: now },
    },
  }
}

/** The retry endpoint answered. A 202 (duplicate or not) means accepted; a
 *  422 means the server will not retry this; anything else is shown as is. */
export function applyRetryResult(
  state: RunState,
  stepId: string,
  attempt: number,
  result: RetryOutcome,
  now: number,
): RunState {
  const key = attemptKey(stepId, attempt)
  const prev = state.retries[key] ?? {
    stepId,
    attempt,
    phase: 'requested' as const,
    requestedAt: now,
  }
  const next: RetryRequest = result.ok
    ? {
        stepId,
        attempt,
        requestedAt: prev.requestedAt,
        phase: 'accepted',
        acceptedAt: now,
      }
    : {
        stepId,
        attempt,
        requestedAt: prev.requestedAt,
        phase: 'error',
        code: result.code,
        message: result.message,
        notRetryable: result.code === 'NOT_RETRYABLE',
      }
  return { ...state, retries: { ...state.retries, [key]: next } }
}

/**
 * The failures someone has to act on: for each step, its latest attempt, if
 * that failed and nothing newer has been put on the instrument. A failure that
 * has been superseded is history: still a red bar, no longer here.
 *
 * `now` drives the "not confirmed" rule, so pass the clock the page renders
 * with. Precedence: needs service > not receiving updates > queued (an event
 * is evidence) > no confirmation in time > what the request says > idle.
 */
export function selectFailures(state: RunState, now: number): FailureView[] {
  const latest = new Map<string, Attempt>()
  for (const a of state.attempts) {
    const cur = latest.get(a.stepId)
    if (!cur || a.attempt > cur.attempt) latest.set(a.stepId, a)
  }

  const out: FailureView[] = []
  for (const a of latest.values()) {
    if (a.status !== 'failed') continue
    const key = attemptKey(a.stepId, a.attempt)
    const req = state.retries[key]
    const queued = state.refused[attemptKey(a.stepId, a.attempt + 1)] === true
    const inFlight =
      queued || req?.phase === 'requested' || req?.phase === 'accepted'
    const notLive = state.connection.status !== 'live'
    const view: FailureView = {
      attempt: a,
      phase: 'idle',
      retriedElsewhere: queued && !req,
    }

    if (a.error?.retryable === false || req?.notRetryable) {
      view.phase = 'needs_service'
      if (req?.notRetryable) view.message = req.message
    } else if (inFlight && notLive) {
      view.phase = 'unconfirmed'
    } else if (queued) {
      view.phase = 'queued'
    } else if (
      req?.phase === 'accepted' &&
      now - (req.acceptedAt ?? now) >= RETRY_CONFIRM_MS
    ) {
      view.phase = 'unconfirmed'
    } else if (req) {
      view.phase = req.phase
      if (req.phase === 'error') view.message = req.message
    }
    out.push(view)
  }
  return out.sort(
    (x, y) =>
      (x.attempt.endedAt ?? 0) - (y.attempt.endedAt ?? 0) ||
      x.attempt.stepId.localeCompare(y.attempt.stepId),
  )
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const STATUS_RANK: Record<AttemptStatus, number> = {
  dispatched: 1,
  running: 2,
  done: 3,
  failed: 3,
}

const RUN_STATUS_RANK: Record<string, number> = {
  unknown: 0,
  created: 1,
  running: 2,
  blocked: 3,
  completed: 4,
}

const EVENT_TYPES = new Set<EventType>([
  'step.dispatched',
  'step.refused',
  'step.started',
  'step.finished',
  'step.failed',
  'run.blocked',
  'run.completed',
])

function attemptKey(stepId: string, attempt: number): string {
  return `${stepId}#${attempt}`
}

function applyStepEvent(
  state: RunState,
  e: LabEvent,
  stepId: string,
  attempt: number,
): RunState {
  const key = attemptKey(stepId, attempt)
  const prev = state.byKey[key]

  if (e.type === 'step.refused') {
    // Nothing is on the instrument yet, so this marks the attempt rather than
    // creating it. The dispatch picks the mark up whenever it arrives.
    const refused = { ...state.refused, [key]: true as const }
    const byKey = prev
      ? { ...state.byKey, [key]: { ...prev, refused: true } }
      : state.byKey
    return { ...state, refused, byKey }
  }

  const at = parseAt(e.at)
  const patch: Attempt = {
    stepId,
    attempt,
    deviceId: e.device_id ?? '',
    status: 'dispatched',
    refused: false,
    startedAt: null,
    endedAt: null,
    error: null,
  }
  if (e.type === 'step.started') {
    patch.status = 'running'
    patch.startedAt = at
  } else if (e.type === 'step.finished') {
    patch.status = 'done'
    patch.endedAt = at
  } else if (e.type === 'step.failed') {
    patch.status = 'failed'
    patch.endedAt = at
    patch.error = e.error ?? null
  }
  return {
    ...state,
    byKey: {
      ...state.byKey,
      [key]: mergeAttempt(prev, state.refused[key] === true, patch),
    },
  }
}

/** The order-proof merge. Status takes the higher rank; every other field
 *  keeps whichever value was set first, and is never overwritten with null. */
function mergeAttempt(
  prev: Attempt | undefined,
  refused: boolean,
  patch: Attempt,
): Attempt {
  if (!prev) return { ...patch, refused: patch.refused || refused }
  return {
    stepId: prev.stepId,
    attempt: prev.attempt,
    deviceId: prev.deviceId || patch.deviceId,
    status:
      STATUS_RANK[patch.status] > STATUS_RANK[prev.status]
        ? patch.status
        : prev.status,
    refused: prev.refused || patch.refused || refused,
    startedAt: prev.startedAt ?? patch.startedAt,
    endedAt: prev.endedAt ?? patch.endedAt,
    error: prev.error ?? patch.error,
  }
}

function laterRunStatus(current: string, incoming: string): string {
  const a = RUN_STATUS_RANK[current] ?? 0
  const b = RUN_STATUS_RANK[incoming] ?? 0
  return b > a ? incoming : current
}

/** A gap frame: seqs from+1 .. earliest-1 happened and will never arrive. */
function applyGap(
  state: RunState,
  frame: { from: number; earliest: number },
): RunState {
  const [contiguous, seen] = advance(
    Math.max(state.contiguous, frame.earliest - 1),
    state.seen,
  )
  return finish({
    ...state,
    gap: state.gap ?? { from: frame.from, earliest: frame.earliest },
    contiguous,
    seen,
  })
}

/** Move `contiguous` past every seq we hold, and forget the ones it passes. */
function advance(
  contiguous: number,
  seen: Record<number, true>,
): [number, Record<number, true>] {
  let c = contiguous
  while (seen[c + 1]) c++
  const kept: Record<number, true> = {}
  for (const k of Object.keys(seen)) {
    const n = Number(k)
    if (n > c) kept[n] = true
  }
  return [c, kept]
}

/** Recompute everything derived, after any change. */
function finish(state: RunState): RunState {
  return {
    ...state,
    attempts: Object.values(state.byKey),
    lastSeq: state.contiguous,
    connection: deriveConnection(state),
  }
}

function deriveConnection(s: RunState): Connection {
  const lastSeq = s.contiguous
  if (s.socket === 'closed') {
    return s.gap
      ? { status: 'stale', lastSeq, note: NOTE_CLOSED_AFTER_GAP }
      : { status: 'stale', lastSeq }
  }
  if (s.gap) return { status: 'gap', lastSeq }
  if (s.socket === 'connecting') return { status: 'connecting', lastSeq }
  // Every key in `seen` is above a missing seq, so its size is how many
  // events have arrived since the hole opened.
  if (Object.keys(s.seen).length >= HOLE_TOLERANCE) {
    return { status: 'stale', lastSeq, note: NOTE_HOLE }
  }
  return { status: 'live', lastSeq }
}

function byTimeThenId(a: Attempt, b: Attempt): number {
  const ta = a.startedAt ?? a.endedAt ?? Number.POSITIVE_INFINITY
  const tb = b.startedAt ?? b.endedAt ?? Number.POSITIVE_INFINITY
  if (ta !== tb) return ta < tb ? -1 : 1
  if (a.stepId !== b.stepId) return a.stepId < b.stepId ? -1 : 1
  return a.attempt - b.attempt
}

/** ISO-8601 to epoch ms. The simulator sends microseconds; keep milliseconds. */
function parseAt(at: string | null | undefined): number | null {
  if (!at) return null
  const ms = Date.parse(at.replace(/(\.\d{3})\d+/, '$1'))
  return Number.isNaN(ms) ? null : ms
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isGapFrame(
  msg: unknown,
): msg is { type: 'gap'; from: number; earliest: number } {
  return (
    isRecord(msg) &&
    msg.type === 'gap' &&
    Number.isInteger(msg.from) &&
    Number.isInteger(msg.earliest)
  )
}

function isLabEvent(msg: unknown): msg is LabEvent {
  if (!isRecord(msg)) return false
  const { seq, run_id, type, at, step_id, attempt } = msg
  if (!Number.isInteger(seq) || (seq as number) < 1) return false
  if (typeof run_id !== 'string' || typeof at !== 'string') return false
  if (!EVENT_TYPES.has(type as EventType)) return false
  if (String(type).startsWith('step.')) {
    if (typeof step_id !== 'string') return false
    if (!Number.isInteger(attempt) || (attempt as number) < 1) return false
  }
  return true
}

export type { LabEvent, Snapshot, StepError }
