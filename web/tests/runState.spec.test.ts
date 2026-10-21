// Behaviour from docs/spec/requirements.md that the provided gates do not
// cover. Requirement ids are in each test's name.
import { describe, expect, test } from 'vitest'
import fixture from './fixtures/run-with-retry.json'
import {
  HOLE_TIMEOUT_MS,
  HOLE_TOLERANCE,
  NOTE_CLOSED_AFTER_GAP,
  NOTE_HOLE,
  applyEvent,
  applyMessage,
  applySnapshot,
  applyTick,
  applyTransport,
  createRunState,
  selectAttempt,
  selectConnection,
  selectResumeFrom,
  selectRunStatus,
  selectTracks,
} from '../src/lib/runState'
import type { LabEvent, RunState, Snapshot } from '../src/lib/runState'

const CLEAN = fixture as unknown as LabEvent[]

const fold = (events: unknown[], from: RunState = createRunState()): RunState =>
  events.reduce<RunState>((s, e) => applyMessage(s, e), from)

const live = () => applyTransport(createRunState(), 'open')

const attempts = (s: RunState) => selectTracks(s).flatMap((t) => t.attempts)

function snapshot(
  seq: number,
  steps: Partial<Snapshot['run']['steps'][number]>[],
  status = 'running',
): Snapshot {
  return {
    seq,
    run: {
      id: 'r-1',
      status,
      steps: steps.map((s) => ({
        id: 'x',
        device_id: 'liquid-handler-1',
        depends_on: null,
        status: 'pending',
        attempt: 0,
        started_at: null,
        ended_at: null,
        error: null,
        ...s,
      })),
    },
  }
}

describe('R5.7: events for another run', () => {
  test('are ignored, and do not count as received', () => {
    const base = applySnapshot(createRunState(), snapshot(0, []))
    const foreign = { ...CLEAN[0]!, run_id: 'r-2' }
    const s = applyMessage(base, foreign)
    expect(attempts(s)).toHaveLength(0)
    expect(selectResumeFrom(s)).toBe(0)
  })
})

describe('R5.8: frames that are not events', () => {
  test.each([
    null,
    'hello',
    42,
    [],
    { type: 'step.started' },
    { ...CLEAN[1]!, seq: 0 },
    { ...CLEAN[1]!, type: 'step.teleported' },
    { ...CLEAN[1]!, step_id: undefined },
    { type: 'gap', from: 'a', earliest: 3 },
  ])('%j is ignored', (msg) => {
    const before = fold(CLEAN.slice(0, 5))
    expect(applyMessage(before, msg)).toBe(before)
  })
})

describe('R5.10: refusals', () => {
  // seq 6: fill_buffer_plate attempt 1 refused; its dispatch comes later.
  const refusal = CLEAN.find((e) => e.type === 'step.refused')!
  const key = (s: RunState) =>
    attempts(s).find(
      (a) => a.stepId === refusal.step_id && a.attempt === refusal.attempt,
    )

  test('mark the attempt whether they arrive before or after its dispatch', () => {
    const inOrder = fold(CLEAN)
    const refusalLast = fold([...CLEAN.filter((e) => e !== refusal), refusal])
    expect(key(inOrder)?.refused).toBe(true)
    expect(selectTracks(refusalLast)).toEqual(selectTracks(inOrder))
  })

  test('do not put anything on an instrument by themselves', () => {
    const s = fold([refusal])
    expect(attempts(s)).toHaveLength(0)
  })
})

describe('R5.11: run status only moves forward', () => {
  test('a late run.blocked does not undo run.completed', () => {
    const done = { ...CLEAN[0]!, seq: 1, type: 'run.completed' as const }
    const blocked = { ...CLEAN[0]!, seq: 2, type: 'run.blocked' as const }
    expect(selectRunStatus(fold([done, blocked]))).toBe('completed')
    expect(selectRunStatus(fold([blocked, done]))).toBe('completed')
  })
})

describe('R5.12: an unknown device', () => {
  test('gets its own track after the known ones, rather than being dropped', () => {
    const odd = {
      ...CLEAN[0]!,
      step_id: 'spin_down',
      device_id: 'centrifuge-9',
    }
    const tracks = selectTracks(fold([odd]))
    expect(tracks.map((t) => t.deviceId)).toEqual([
      'liquid-handler-1',
      'incubator-1',
      'plate-reader-1',
      'centrifuge-9',
    ])
    expect(tracks[3]!.attempts[0]!.stepId).toBe('spin_down')
  })
})

describe('R6: the snapshot', () => {
  test('R6.2: a snapshot older than the events applied moves nothing backwards', () => {
    const all = fold(CLEAN)
    const stale = snapshot(12, [
      {
        id: 'warm_reagent_plate',
        device_id: 'incubator-1',
        status: 'running',
        attempt: 1,
        started_at: '2026-09-01T15:51:15.000000Z',
      },
    ])
    const after = applySnapshot(all, stale)
    expect(selectTracks(after)).toEqual(selectTracks(all))
    expect(selectResumeFrom(after)).toBe(28)
    expect(selectRunStatus(after)).toBe(selectRunStatus(all))
  })

  test('R6.3: a pending step puts no attempt on the timeline', () => {
    const s = applySnapshot(
      createRunState(),
      snapshot(3, [{ id: 'combine', status: 'pending', attempt: 1 }]),
    )
    expect(attempts(s)).toHaveLength(0)
  })

  test('R6.2: events applied before the snapshot are kept and merged', () => {
    const early = fold(CLEAN.slice(0, 3)) // fill_sample_plate: dispatched, started, finished
    const snap = snapshot(2, [
      {
        id: 'fill_sample_plate',
        status: 'running',
        attempt: 1,
        started_at: CLEAN[1]!.at,
      },
    ])
    const s = applySnapshot(early, snap)
    const a = attempts(s).find((x) => x.stepId === 'fill_sample_plate')!
    expect(a.status).toBe('done')
    expect(a.endedAt).not.toBeNull()
    expect(selectResumeFrom(s)).toBe(3)
  })

  test('a failed step in the snapshot keeps its error', () => {
    const error = {
      code: 'CALIBRATION_EXPIRED',
      instrument: 'plate-reader-1',
      detail: 'too old',
      retryable: false,
      context: { service_ticket: 'SVC-3312' },
    }
    const s = applySnapshot(
      createRunState(),
      snapshot(30, [
        {
          id: 'read_plate',
          device_id: 'plate-reader-1',
          status: 'failed',
          attempt: 1,
          started_at: '2026-09-01T15:51:20Z',
          ended_at: '2026-09-01T15:51:22Z',
          error,
        },
      ]),
    )
    expect(attempts(s)[0]!.error).toEqual(error)
  })
})

describe('R7: a missing event', () => {
  const withHole = CLEAN.filter((e) => e.seq !== 11)

  test(`stays live until ${HOLE_TOLERANCE} later events have arrived`, () => {
    const justUnder = withHole.filter((e) => e.seq < 11 + HOLE_TOLERANCE)
    expect(selectConnection(fold(justUnder, live())).status).toBe('live')
    const atLimit = withHole.filter((e) => e.seq <= 11 + HOLE_TOLERANCE)
    const c = selectConnection(fold(atLimit, live()))
    expect(c.status).toBe('stale')
    expect(c.note).toBe(NOTE_HOLE)
  })

  test('R7.3: the warning clears when the missing event turns up', () => {
    const late = CLEAN.find((e) => e.seq === 11)!
    const s = fold([...withHole, late], live())
    expect(selectConnection(s).status).toBe('live')
    expect(selectResumeFrom(s)).toBe(28)
  })

  test('the resume position stops below the hole, so a reconnect refills it', () => {
    expect(selectResumeFrom(fold(withHole, live()))).toBe(10)
  })
})

describe('R4, R8: gaps and the socket', () => {
  const gap = { type: 'gap', from: 10, earliest: 20 }

  test('R4.7: the lost range is written off, so resume moves past it', () => {
    let s = fold(CLEAN.slice(0, 10), live())
    s = applyMessage(s, gap)
    expect(selectResumeFrom(s)).toBe(19)
    s = fold(
      CLEAN.filter((e) => e.seq >= 20),
      s,
    )
    expect(selectResumeFrom(s)).toBe(28)
    expect(selectConnection(s).status).toBe('gap')
  })

  test('R8.3: closing after a gap says stale, and mentions the gap', () => {
    let s = applyMessage(fold(CLEAN.slice(0, 10), live()), gap)
    s = applyTransport(s, 'closed')
    expect(selectConnection(s)).toMatchObject({
      status: 'stale',
      note: NOTE_CLOSED_AFTER_GAP,
    })
    s = applyTransport(s, 'open')
    expect(selectConnection(s).status).toBe('gap')
  })

  test('R8.2: reopening without a gap is live again', () => {
    const s = applyTransport(
      applyTransport(fold(CLEAN, live()), 'closed'),
      'open',
    )
    expect(selectConnection(s).status).toBe('live')
  })

  test('a second gap frame does not overwrite the first', () => {
    let s = applyMessage(fold(CLEAN.slice(0, 10)), gap)
    s = applyMessage(s, { type: 'gap', from: 25, earliest: 27 })
    expect(s.gap).toEqual({ from: 10, earliest: 20 })
  })
})

describe('selectAttempt', () => {
  test('a superseded failure points at the attempt that replaced it', () => {
    const s = fold(CLEAN)
    expect(selectAttempt(s, 'warm_reagent_plate', 1)?.supersededBy).toBe(2)
    expect(selectAttempt(s, 'warm_reagent_plate', 2)?.supersededBy).toBeNull()
    expect(selectAttempt(s, 'nope', 1)).toBeNull()
  })
})

describe('applyEvent directly', () => {
  test('a duplicate returns the same state object', () => {
    const s = fold(CLEAN.slice(0, 3))
    expect(applyEvent(s, CLEAN[1]!)).toBe(s)
  })
})

describe('O5: a hole with nothing after it', () => {
  // read_plate's step.finished (seq 27) lost; only run.completed follows it.
  const lostAtEnd = CLEAN.filter((e) => e.seq !== 27)
  const T = 1_000_000

  test('is not caught by counting, because too few events follow', () => {
    expect(selectConnection(fold(lostAtEnd, live())).status).toBe('live')
  })

  test(`is reported once it has been open ${HOLE_TIMEOUT_MS} ms`, () => {
    let s = applyTick(fold(lostAtEnd, live()), T)
    expect(s.hole).toEqual({ seq: 27, since: T })
    s = applyTick(s, T + HOLE_TIMEOUT_MS - 1)
    expect(selectConnection(s).status).toBe('live')
    s = applyTick(s, T + HOLE_TIMEOUT_MS)
    expect(selectConnection(s)).toMatchObject({
      status: 'stale',
      note: NOTE_HOLE,
    })
  })

  test('clears when the missing event is replayed', () => {
    let s = applyTick(fold(lostAtEnd, live()), T)
    s = applyTick(s, T + HOLE_TIMEOUT_MS)
    s = applyMessage(
      s,
      CLEAN.find((e) => e.seq === 27),
    )
    expect(selectConnection(s).status).toBe('live')
    s = applyTick(s, T + HOLE_TIMEOUT_MS + 250)
    expect(s.hole).toBeNull()
  })

  test('restarts the timer when a different seq becomes the lowest missing', () => {
    const twoHoles = CLEAN.filter((e) => e.seq !== 20 && e.seq !== 27)
    let s = applyTick(
      fold(
        twoHoles.filter((e) => e.seq < 22),
        live(),
      ),
      T,
    )
    expect(s.hole?.seq).toBe(20)
    s = applyMessage(
      s,
      CLEAN.find((e) => e.seq === 20),
    )
    s = fold(
      twoHoles.filter((e) => e.seq >= 22),
      s,
    )
    s = applyTick(s, T + HOLE_TIMEOUT_MS + 100)
    expect(s.hole).toEqual({ seq: 27, since: T + HOLE_TIMEOUT_MS + 100 })
    expect(selectConnection(s).status).toBe('live')
  })

  test('a tick with nothing missing returns the same state', () => {
    const s = fold(CLEAN, live())
    expect(applyTick(s, T)).toBe(s)
  })
})
