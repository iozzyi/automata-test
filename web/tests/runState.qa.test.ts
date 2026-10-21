// Regressions for the QA review (loop 1): QA-1 to QA-4.
import { describe, expect, test } from 'vitest'
import fixture from './fixtures/run-with-retry.json'
import {
  HOLE_TIMEOUT_MS,
  applyMessage,
  applyRetryRequested,
  applyRetryResult,
  applySnapshot,
  applyTick,
  applyTransport,
  createRunState,
  selectConnection,
  selectFailures,
  selectOverdueHole,
  selectRunStatus,
  selectTracks,
} from '../src/lib/runState'
import type { LabEvent, RunState, Snapshot } from '../src/lib/runState'

const CLEAN = fixture as unknown as LabEvent[]
const T = 1_000_000
const fold = (events: unknown[], from: RunState): RunState =>
  events.reduce<RunState>((s, e) => applyMessage(s, e), from)
const live = () => applyTransport(createRunState(), 'open')
const gapFrame = (from: number, earliest: number) => ({
  type: 'gap',
  from,
  earliest,
})

describe('QA-1: a failure that happened inside a gap', () => {
  // The page lost seqs 11-19: warm_reagent_plate failed at 17 and nobody saw.
  const afterGap = () =>
    fold(
      [gapFrame(10, 20), ...CLEAN.filter((e) => e.seq >= 20)],
      fold(CLEAN.slice(0, 10), live()),
    )

  const failedSnapshot: Snapshot = {
    seq: 18,
    run: {
      id: 'r-1',
      status: 'blocked',
      steps: [
        {
          id: 'warm_reagent_plate',
          device_id: 'incubator-1',
          depends_on: null,
          status: 'failed',
          attempt: 1,
          started_at: CLEAN.find((e) => e.seq === 16)!.at,
          ended_at: CLEAN.find((e) => e.seq === 17)!.at,
          error: CLEAN.find((e) => e.seq === 17)!.error!,
        },
        {
          id: 'incubate_samples',
          device_id: 'incubator-1',
          depends_on: null,
          status: 'done',
          attempt: 1,
          started_at: CLEAN.find((e) => e.seq === 7)!.at,
          ended_at: CLEAN.find((e) => e.seq === 13)!.at,
          error: null,
        },
      ],
    },
  }

  test('is invisible from the events alone', () => {
    const s = fold([gapFrame(10, 18)], fold(CLEAN.slice(0, 10), live()))
    expect(selectFailures(s, T)).toEqual([])
  })

  test('gets its card once the snapshot is re-read, and the gap stays admitted', () => {
    const s = applySnapshot(
      fold([gapFrame(10, 18)], fold(CLEAN.slice(0, 10), live())),
      failedSnapshot,
    )
    const [f] = selectFailures(s, T)
    expect(f?.attempt.stepId).toBe('warm_reagent_plate')
    expect(f?.attempt.error?.code).toBe('SETPOINT_NOT_REACHED')
    expect(selectConnection(s).status).toBe('gap')
  })

  test('a bar whose end fell in the gap gets it from the snapshot', () => {
    const before = fold([gapFrame(10, 18)], fold(CLEAN.slice(0, 10), live()))
    const bar = (s: RunState) =>
      selectTracks(s)
        .flatMap((t) => t.attempts)
        .find((a) => a.stepId === 'incubate_samples')
    expect(bar(before)?.status).toBe('running')
    const after = applySnapshot(before, failedSnapshot)
    expect(bar(after)?.status).toBe('done')
    expect(bar(after)?.endedAt).not.toBeNull()
  })

  test('once attempt 2 exists, a late snapshot of the attempt-1 failure brings no card back', () => {
    const s = applySnapshot(afterGap(), failedSnapshot)
    expect(selectFailures(s, T)).toEqual([])
    const warm = selectTracks(s)
      .flatMap((t) => t.attempts)
      .filter((a) => a.stepId === 'warm_reagent_plate')
    expect(warm.map((a) => `${a.attempt}:${a.status}`).sort()).toEqual([
      '1:failed',
      '2:done',
    ])
  })

  test('each gap frame is counted, so the page re-reads every time', () => {
    let s = fold([gapFrame(10, 18)], fold(CLEAN.slice(0, 10), live()))
    expect(s.gaps).toBe(1)
    s = applyMessage(s, gapFrame(20, 24))
    expect(s.gaps).toBe(2)
  })
})

describe('QA-2: "not receiving updates" is about the socket', () => {
  const failedAfterGap = () =>
    fold(
      CLEAN.filter((e) => e.seq >= 12 && e.seq <= 18),
      applyMessage(fold(CLEAN.slice(0, 10), live()), gapFrame(10, 12)),
    )
  const refused2: LabEvent = {
    ...CLEAN.find((e) => e.seq === 19)!,
    type: 'step.refused',
  }

  test('after a gap, with the socket open, a retry is accepted and then queued', () => {
    let s = applyRetryRequested(failedAfterGap(), 'warm_reagent_plate', 1, T)
    s = applyRetryResult(s, 'warm_reagent_plate', 1, { ok: true }, T)
    expect(selectConnection(s).status).toBe('gap')
    expect(selectFailures(s, T)[0]?.phase).toBe('accepted')
    s = applyMessage(s, refused2)
    expect(selectFailures(s, T)[0]?.phase).toBe('queued')
  })

  test('with the socket closed it is still "not confirmed"', () => {
    let s = applyRetryRequested(failedAfterGap(), 'warm_reagent_plate', 1, T)
    s = applyTransport(s, 'closed')
    expect(selectFailures(s, T)[0]?.phase).toBe('unconfirmed')
  })
})

describe('QA-3: run status from step events', () => {
  test('a snapshot taken before the start does not leave the run "created"', () => {
    const created: Snapshot = {
      seq: 0,
      run: { id: 'r-1', status: 'created', steps: [] },
    }
    const s = fold(CLEAN.slice(0, 16), applySnapshot(live(), created))
    expect(selectRunStatus(s)).toBe('running')
  })

  test('step events never move a blocked or completed run back', () => {
    const s = fold(CLEAN, live())
    expect(selectRunStatus(s)).toBe('completed')
    const blocked = fold(CLEAN.slice(0, 18), live())
    expect(selectRunStatus(blocked)).toBe('blocked')
  })
})

describe('QA-4: a hole after a gap is still refilled', () => {
  test('the overdue hole is reported for refill while the banner shows the gap', () => {
    let s = applyMessage(fold(CLEAN.slice(0, 10), live()), gapFrame(10, 12))
    s = fold(
      CLEAN.filter((e) => e.seq >= 12 && e.seq !== 14 && e.seq <= 20),
      s,
    )
    s = applyTick(s, T)
    expect(selectOverdueHole(s)).toBeNull()
    s = applyTick(s, T + HOLE_TIMEOUT_MS)
    expect(selectConnection(s).status).toBe('gap')
    expect(selectOverdueHole(s)).toBe(14)
  })

  test('nothing to refill while the socket is down', () => {
    let s = fold(
      CLEAN.filter((e) => e.seq !== 5 && e.seq <= 20),
      live(),
    )
    s = applyTransport(s, 'closed')
    expect(selectOverdueHole(s)).toBeNull()
  })
})
