// R16: how the run stands, and where its timeline ends.
import { describe, expect, test } from 'vitest'
import fixture from './fixtures/run-with-retry.json'
import {
  applyMessage,
  applySnapshot,
  applyRetryRequested,
  applyRetryResult,
  applyTransport,
  createRunState,
  selectOutcome,
  selectTimelineEnd,
} from '../src/lib/runState'
import type { LabEvent, RunState } from '../src/lib/runState'

const CLEAN = fixture as unknown as LabEvent[]
const T = Date.parse('2026-09-01T16:00:00Z') // well after the fixture run
const upTo = (seq: number): RunState =>
  CLEAN.filter((e) => e.seq <= seq).reduce<RunState>(
    (s, e) => applyMessage(s, e),
    applyTransport(createRunState(), 'open'),
  )
const at = (seq: number) => Date.parse(CLEAN.find((e) => e.seq === seq)!.at)

describe('selectTimelineEnd', () => {
  test('a completed run stops at the last report, not the clock', () => {
    expect(selectTimelineEnd(upTo(28), T)).toBe(at(27)) // read_plate finished
  })

  test('a running or blocked run follows the clock', () => {
    expect(selectTimelineEnd(upTo(10), T)).toBe(T)
    expect(selectTimelineEnd(upTo(18), T)).toBe(T)
  })
})

describe('selectOutcome', () => {
  test('nothing to say before anything has happened', () => {
    expect(selectOutcome(createRunState(), T)).toBeNull()
  })

  test('running: how many steps are done', () => {
    expect(selectOutcome(upTo(9), T)).toBe('Running · 2 steps done')
  })

  test('a failure while other steps still run is mentioned', () => {
    expect(selectOutcome(upTo(17), T)).toBe(
      'Running · 4 steps done · 1 step failed',
    )
  })

  test('blocked by a retryable failure', () => {
    expect(selectOutcome(upTo(18), T)).toBe(
      'Blocked: warm_reagent_plate failed and can be retried',
    )
  })

  test('blocked by a fault that needs service', () => {
    const s = CLEAN.filter((e) => e.seq <= 18)
      .map((e) =>
        e.type === 'step.failed'
          ? { ...e, error: { ...e.error!, retryable: false } }
          : e,
      )
      .reduce<RunState>(
        (st, e) => applyMessage(st, e),
        applyTransport(createRunState(), 'open'),
      )
    expect(selectOutcome(s, T)).toBe(
      'Blocked: warm_reagent_plate needs service',
    )
  })

  test('still "blocked" while the retry runs, so say it is retrying', () => {
    expect(selectOutcome(upTo(20), T)).toBe(
      'Retrying warm_reagent_plate (attempt 2)',
    )
  })

  test('once the retried step is done, the run is running again (status still says blocked)', () => {
    expect(selectOutcome(upTo(23), T)).toBe(
      'Running again after a retry · 5 steps done',
    )
  })

  test('a requested retry is not yet "retrying": the timeline has not moved', () => {
    let s = applyRetryRequested(upTo(18), 'warm_reagent_plate', 1, T)
    s = applyRetryResult(s, 'warm_reagent_plate', 1, { ok: true }, T)
    expect(selectOutcome(s, T)).toBe(
      'Blocked: retry of warm_reagent_plate requested, waiting for the instrument',
    )
  })

  test('completed: how long, how many steps, how many retries', () => {
    const took = ((at(27) - at(2)) / 1000).toFixed(1)
    expect(selectOutcome(upTo(28), T)).toBe(
      `Completed in ${took} s · 7 steps · 1 retry`,
    )
  })
})

describe('QA review of R16 (QA-22 to QA-24, QA-27)', () => {
  const gap = (from: number, earliest: number) => ({
    type: 'gap',
    from,
    earliest,
  })
  const blocked: LabEvent = { ...CLEAN.find((e) => e.seq === 18)! }

  test('QA-22: blocked by a failure that never arrived does not claim a retry', () => {
    // Seqs 11-17 (incl. the failure) lost; run.blocked arrives.
    let s = applyMessage(upTo(10), gap(10, 18))
    s = applyMessage(s, blocked)
    expect(selectOutcome(s, T)).toBe(
      'Blocked (details not received) (record incomplete)',
    )
  })

  test('QA-23: while a retry is in flight the line agrees with the card', () => {
    let s = applyRetryRequested(upTo(18), 'warm_reagent_plate', 1, T)
    s = applyRetryResult(s, 'warm_reagent_plate', 1, { ok: true }, T)
    expect(selectOutcome(s, T)).toBe(
      'Blocked: retry of warm_reagent_plate requested, waiting for the instrument',
    )
  })

  test('QA-24: totals after a gap say the record is incomplete', () => {
    const s = CLEAN.filter((e) => e.seq >= 27).reduce<RunState>(
      (st, e) => applyMessage(st, e),
      applyMessage(upTo(3), gap(3, 27)),
    )
    expect(selectOutcome(s, T)).toMatch(
      /^Completed in .* \(record incomplete\)$/,
    )
  })

  test('QA-27: a run that was created but never started says so', () => {
    const s = applySnapshot(createRunState(), {
      seq: 0,
      run: { id: 'r-1', status: 'created', steps: [] },
    })
    expect(selectOutcome(s, T)).toBe('Not started yet')
  })
})
