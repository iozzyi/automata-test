// Gate 4 -- the one the live checks cannot see.
//
// The fixture is a real recorded run: 28 events including two refusals, a
// failure, an operator retry, and the second attempt that follows it.
//
// A reducer that simply applies whatever arrives passes every check in the
// browser and fails most of these.
import { describe, expect, test } from 'vitest'
import fixture from './fixtures/run-with-retry.json'
import {
  applyMessage,
  applySnapshot,
  applyTransport,
  createRunState,
  selectConnection,
  selectResumeFrom,
  selectTracks,
} from '../src/lib/runState'
import type { LabEvent, RunState, Snapshot, Track } from '../src/lib/runState'

const CLEAN = fixture as unknown as LabEvent[]

const fold = (
  events: LabEvent[],
  from: RunState = createRunState(),
): RunState => events.reduce((s, e) => applyMessage(s, e), from)

/** Adjacent pairs swapped, then every fifth event sent twice. */
function scramble(events: LabEvent[]): LabEvent[] {
  const swapped: LabEvent[] = []
  for (let i = 0; i < events.length; i += 2) {
    const a = events[i]!
    const b = events[i + 1]
    if (b) swapped.push(b, a)
    else swapped.push(a)
  }
  return swapped.flatMap((e, i) => (i % 5 === 0 ? [e, e] : [e]))
}

describe('ordering', () => {
  test('reordered and duplicated delivery converges on the same state', () => {
    const clean = selectTracks(fold(CLEAN))
    // 7 steps, plus the second attempt at warm_reagent_plate.
    expect(allAttempts(clean)).toHaveLength(8)
    expect(selectTracks(fold(scramble(CLEAN)))).toEqual(clean)
  })

  test('a duplicate does not advance the resume position twice', () => {
    const once = fold(CLEAN)
    expect(selectResumeFrom(once)).toBe(28)
    const twice = fold([...CLEAN, ...CLEAN])
    expect(selectResumeFrom(twice)).toBe(selectResumeFrom(once))
    expect(selectTracks(twice)).toEqual(selectTracks(once))
  })

  test('the resume position is the highest sequence number applied', () => {
    expect(selectResumeFrom(fold(CLEAN))).toBe(CLEAN[CLEAN.length - 1]!.seq)
  })
})

describe('identity', () => {
  test('a retry does not erase the attempt it replaces', () => {
    const attempts = allAttempts(selectTracks(fold(CLEAN))).filter(
      (a) => a.stepId === 'warm_reagent_plate',
    )
    expect(attempts.map((a) => a.attempt).sort()).toEqual([1, 2])
    expect(attempts.find((a) => a.attempt === 1)?.status).toBe('failed')
    expect(attempts.find((a) => a.attempt === 2)?.status).toBe('done')
  })

  test('no device runs two attempts at once', () => {
    const tracks = selectTracks(fold(CLEAN))
    expect(
      allAttempts(tracks).filter((a) => a.startedAt !== null),
    ).toHaveLength(8)
    for (const track of tracks) {
      const spans = track.attempts
        .filter((a) => a.startedAt !== null)
        .map((a) => [a.startedAt!, a.endedAt ?? Infinity] as const)
        .sort((x, y) => x[0] - y[0])
      for (let i = 1; i < spans.length; i++) {
        expect(
          spans[i]![0],
          `${track.deviceId} overlaps`,
        ).toBeGreaterThanOrEqual(spans[i - 1]![1])
      }
    }
  })
})

describe('the present is not the past', () => {
  test('an attempt that has started and not finished has no end', () => {
    const upToFirstStart = CLEAN.slice(
      0,
      CLEAN.findIndex((e) => e.type === 'step.started') + 1,
    )
    const running = allAttempts(selectTracks(fold(upToFirstStart))).filter(
      (a) => a.status === 'running',
    )
    expect(running.length).toBeGreaterThan(0)
    for (const a of running) expect(a.endedAt).toBeNull()
  })
})

describe('snapshot watermark', () => {
  test('events already covered by the snapshot are ignored', () => {
    const cut = 12
    const snap = snapshotAt(cut)
    const fromSnapshotOnly = fold(
      CLEAN.slice(cut),
      applySnapshot(createRunState(), snap),
    )
    expect(allAttempts(selectTracks(fromSnapshotOnly)).length).toBeGreaterThan(
      0,
    )
    const withStaleReplay = fold(CLEAN, applySnapshot(createRunState(), snap))
    expect(selectTracks(withStaleReplay)).toEqual(
      selectTracks(fromSnapshotOnly),
    )
  })

  test('the snapshot sets the resume position', () => {
    expect(
      selectResumeFrom(applySnapshot(createRunState(), snapshotAt(12))),
    ).toBe(12)
  })
})

describe('when a sequence number never arrives', () => {
  // Holding an early-arriving event until the ones in front of it turn up is
  // the right idea. It also means that if one of them is genuinely lost, every
  // event behind it waits forever -- and the screen sits there looking healthy.
  const live = () => applyTransport(createRunState(), 'open')

  test('a complete stream stays live', () => {
    expect(selectConnection(fold(CLEAN, live())).status).toBe('live')
  })

  test('a permanently missing event does not freeze the screen in silence', () => {
    const withHole = CLEAN.filter((e) => e.seq !== 11)
    expect(withHole).toHaveLength(CLEAN.length - 1)
    // Before the hole there is nothing wrong, and the screen has to say so --
    // otherwise "not live" below means nothing.
    expect(selectConnection(fold(CLEAN.slice(0, 10), live())).status).toBe(
      'live',
    )
    expect(selectConnection(fold(withHole, live())).status).not.toBe('live')
  })

  test('the run keeps moving once the missing event is written off', () => {
    const withHole = CLEAN.filter((e) => e.seq !== 11)
    const attempts = allAttempts(selectTracks(fold(withHole, live())))
    // Everything after seq 11 must still land. Parking it forever is not an
    // answer -- the lab carried on whether we heard about it or not.
    expect(attempts.length).toBeGreaterThanOrEqual(7)
  })
})

describe('why a step failed', () => {
  // The instrument said a great deal about what went wrong. Throwing it away in
  // the reducer means nothing downstream can ever show it.
  test('the reason a step failed survives into the state', () => {
    const failed = allAttempts(selectTracks(fold(CLEAN))).find(
      (a) => a.status === 'failed',
    )
    expect(failed, 'the fixture contains a failed attempt').toBeDefined()
    expect(failed!.error?.code).toBe('SETPOINT_NOT_REACHED')
    expect(failed!.error?.instrument).toBe('incubator-1')
    // The open part. Different instruments report different keys; whatever this
    // one sent has to arrive intact.
    expect(failed!.error?.context?.actual_c).toBe(31.2)
  })

  test('a successful retry clears the error from its own attempt', () => {
    const attempts = allAttempts(selectTracks(fold(CLEAN))).filter(
      (a) => a.stepId === 'warm_reagent_plate',
    )
    expect(attempts.find((a) => a.attempt === 1)?.error).not.toBeNull()
    expect(attempts.find((a) => a.attempt === 2)?.error).toBeNull()
  })

  test('whether a failure can be retried at all is carried, not assumed', () => {
    const withUnretryable: LabEvent[] = CLEAN.map((e) =>
      e.type === 'step.failed'
        ? {
            ...e,
            error: {
              ...e.error!,
              retryable: false,
              code: 'CALIBRATION_EXPIRED',
            },
          }
        : e,
    )
    const failed = allAttempts(selectTracks(fold(withUnretryable))).find(
      (a) => a.error?.code === 'CALIBRATION_EXPIRED',
    )
    expect(failed, 'the failure must reach the state layer').toBeDefined()
    expect(failed!.error?.retryable).toBe(false)
  })
})

describe('connection honesty', () => {
  test('a closed socket is not reported as live', () => {
    expect(selectConnection(applyTransport(fold(CLEAN), 'closed')).status).toBe(
      'stale',
    )
  })

  test('a gap frame is surfaced, not swallowed', () => {
    const s = applyMessage(fold(CLEAN.slice(0, 10)), {
      type: 'gap',
      from: 10,
      earliest: 40,
    })
    expect(selectConnection(s).status).toBe('gap')
  })

  test('reconnecting after a gap does not restore the claim of completeness', () => {
    let s = applyMessage(fold(CLEAN.slice(0, 10)), {
      type: 'gap',
      from: 10,
      earliest: 40,
    })
    s = applyTransport(s, 'open')
    expect(selectConnection(s).status).toBe('gap')
  })
})

function allAttempts(tracks: Track[]) {
  return tracks.flatMap((t) => t.attempts)
}

/** Build the snapshot the server would return at sequence `seq`. */
function snapshotAt(seq: number): Snapshot {
  const latest = new Map<
    string,
    {
      device: string
      status: string
      started: string | null
      ended: string | null
      attempt: number
    }
  >()
  for (const e of CLEAN.filter((x) => x.seq <= seq)) {
    if (!e.step_id || !e.device_id || !e.attempt) continue
    const cur = latest.get(e.step_id) ?? {
      device: e.device_id,
      status: 'pending',
      started: null,
      ended: null,
      attempt: e.attempt,
    }
    cur.attempt = Math.max(cur.attempt, e.attempt)
    if (e.type === 'step.started') {
      cur.status = 'running'
      cur.started = e.at
      cur.ended = null
    }
    if (e.type === 'step.dispatched') cur.status = 'dispatched'
    if (e.type === 'step.finished') {
      cur.status = 'done'
      cur.ended = e.at
    }
    if (e.type === 'step.failed') {
      cur.status = 'failed'
      cur.ended = e.at
    }
    latest.set(e.step_id, cur)
  }
  return {
    seq,
    run: {
      id: 'r-1',
      status: 'running',
      steps: [...latest].map(([id, v]) => ({
        id,
        device_id: v.device,
        depends_on: null,
        status: v.status,
        attempt: v.attempt,
        started_at: v.started,
        ended_at: v.ended,
        error: null,
      })),
    },
  }
}
