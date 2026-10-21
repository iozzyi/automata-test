// ---------------------------------------------------------------------------
// THIS IS THE EXERCISE. See TASK 2 in README.md.
// ---------------------------------------------------------------------------
//
// Everything the screen shows comes from here. Two sources feed it:
//
//   * a snapshot -- current state, and the stream position it reflects
//   * a stream of events, which can arrive late, twice, or out of order
//
// Nothing below is implemented. The timeline renders whatever selectTracks
// returns, so it is blank until you make it return something.
//
// Plain TypeScript on purpose: no React in this file, so the tests call
// straight into it. Keep the exported signatures -- they do.
import type { LabEvent, Snapshot, StepError } from './types'

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

/** Shape freely. The selectors are the contract, not this. */
export interface RunState {
  runStatus: string
  attempts: Attempt[]
  lastSeq: number
  connection: Connection
}

export function createRunState(): RunState {
  return {
    runStatus: 'unknown',
    attempts: [],
    lastSeq: 0,
    connection: { status: 'connecting', lastSeq: 0 },
  }
}

/**
 * Fold in a snapshot.
 *
 * TODO(candidate): snap.seq says where this snapshot sits in the stream.
 * Record it, or you cannot tell which events it already accounts for.
 */
export function applySnapshot(state: RunState, snap: Snapshot): RunState {
  void snap
  return state
}

/**
 * Fold in one frame off the socket.
 *
 * The argument is `unknown` because not everything on the wire is a LabEvent.
 * Deciding what a frame is, and what to do with one you do not recognise, is
 * part of the job.
 *
 * TODO(candidate): implement.
 */
export function applyMessage(state: RunState, msg: unknown): RunState {
  void msg
  return state
}

/**
 * Fold in one already-typed event. applyMessage delegates here once it has
 * decided a frame is an event.
 *
 * TODO(candidate): implement.
 */
export function applyEvent(state: RunState, e: LabEvent): RunState {
  void e
  return state
}

/**
 * Fold in a transport change: the socket opened, or it went away.
 *
 * TODO(candidate): a closed socket does not change what the lab is doing, but
 * it does change what this screen can honestly claim to know.
 */
export function applyTransport(
  state: RunState,
  kind: 'open' | 'closed',
): RunState {
  void kind
  return state
}

/** One track per device, in DEVICES order. Overlapping attempts on one track
 *  are physically impossible -- an instrument does one thing at a time. */
export function selectTracks(state: RunState): Track[] {
  void state
  return []
}

export function selectRunStatus(state: RunState): string {
  return state.runStatus
}

export function selectConnection(state: RunState): Connection {
  return state.connection
}

/** What to ask the server to resume from on the next connection attempt. */
export function selectResumeFrom(state: RunState): number {
  void state
  return 0
}

export type { LabEvent, Snapshot, StepError }
