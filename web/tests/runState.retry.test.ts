// The failure panel's state: which failures need action (R11) and what the
// card claims between the click and the stream (R12). See design section 4.2.
import { describe, expect, test } from 'vitest'
import fixture from './fixtures/run-with-retry.json'
import {
  RETRY_CONFIRM_MS,
  applyMessage,
  applyRetryRequested,
  applyRetryResult,
  applyTransport,
  createRunState,
  selectFailures,
  selectTracks,
} from '../src/lib/runState'
import type { LabEvent, RunState } from '../src/lib/runState'

const CLEAN = fixture as unknown as LabEvent[]
const STEP = 'warm_reagent_plate'
const T = 1_000_000 // an arbitrary "now"

const fold = (events: LabEvent[], from: RunState): RunState =>
  events.reduce<RunState>((s, e) => applyMessage(s, e), from)

/** Live, up to and including seq 18 (step.failed attempt 1, run.blocked). */
const failed = () =>
  fold(
    CLEAN.filter((e) => e.seq <= 18),
    applyTransport(createRunState(), 'open'),
  )

const dispatch2 = CLEAN.find((e) => e.seq === 19)! // step.dispatched attempt 2
const refused2: LabEvent = { ...dispatch2, type: 'step.refused' }

const ok = { ok: true } as const
const phase = (s: RunState, now = T) => selectFailures(s, now)[0]?.phase

describe('R11: which failures need action', () => {
  test('a failure appears as soon as step.failed arrives, before run.blocked', () => {
    const s = fold(
      CLEAN.filter((e) => e.seq <= 17),
      applyTransport(createRunState(), 'open'),
    )
    const [f] = selectFailures(s, T)
    expect(f?.attempt.stepId).toBe(STEP)
    expect(f?.attempt.attempt).toBe(1)
    expect(f?.phase).toBe('idle')
    expect(f?.attempt.error?.code).toBe('SETPOINT_NOT_REACHED')
  })

  test('once the next attempt is on the instrument, it is history', () => {
    const s = fold([dispatch2], failed())
    expect(selectFailures(s, T)).toEqual([])
    // ...but the red bar and its reason are still on the timeline.
    const first = selectTracks(s)
      .flatMap((t) => t.attempts)
      .find((a) => a.stepId === STEP && a.attempt === 1)
    expect(first?.status).toBe('failed')
    expect(first?.error).not.toBeNull()
  })

  test('a clean run has nothing to act on', () => {
    const s = fold(CLEAN, applyTransport(createRunState(), 'open'))
    expect(selectFailures(s, T)).toEqual([])
  })

  test('a fault the instrument says is not retryable needs service', () => {
    const s = fold(
      CLEAN.filter((e) => e.seq <= 18).map((e) =>
        e.type === 'step.failed'
          ? { ...e, error: { ...e.error!, retryable: false } }
          : e,
      ),
      applyTransport(createRunState(), 'open'),
    )
    expect(phase(s)).toBe('needs_service')
  })
})

describe('R12: between the click and the stream', () => {
  test('requested, then accepted on 202', () => {
    let s = applyRetryRequested(failed(), STEP, 1, T)
    expect(phase(s)).toBe('requested')
    s = applyRetryResult(s, STEP, 1, ok, T + 50)
    expect(phase(s, T + 50)).toBe('accepted')
  })

  test('queued once step.refused names the next attempt', () => {
    let s = applyRetryRequested(failed(), STEP, 1, T)
    s = applyRetryResult(s, STEP, 1, ok, T)
    s = fold([{ ...refused2, seq: 19 }], s)
    expect(phase(s)).toBe('queued')
  })

  test('the card leaves when the next attempt is dispatched', () => {
    let s = applyRetryRequested(failed(), STEP, 1, T)
    s = applyRetryResult(s, STEP, 1, ok, T)
    s = fold([dispatch2], s)
    expect(selectFailures(s, T)).toEqual([])
  })

  test(`no event ${RETRY_CONFIRM_MS / 1000} s after a 202 is "not confirmed"`, () => {
    let s = applyRetryRequested(failed(), STEP, 1, T)
    s = applyRetryResult(s, STEP, 1, ok, T)
    expect(phase(s, T + RETRY_CONFIRM_MS - 1)).toBe('accepted')
    expect(phase(s, T + RETRY_CONFIRM_MS)).toBe('unconfirmed')
  })

  test('a queued retry does not time out: the refusal was evidence', () => {
    let s = applyRetryRequested(failed(), STEP, 1, T)
    s = applyRetryResult(s, STEP, 1, ok, T)
    s = fold([{ ...refused2, seq: 19 }], s)
    expect(phase(s, T + RETRY_CONFIRM_MS * 5)).toBe('queued')
  })

  test.each(['requested', 'accepted', 'queued'] as const)(
    'a %s retry is "not confirmed" while the screen is not live',
    (step) => {
      let s = applyRetryRequested(failed(), STEP, 1, T)
      if (step !== 'requested') s = applyRetryResult(s, STEP, 1, ok, T)
      if (step === 'queued') s = fold([{ ...refused2, seq: 19 }], s)
      s = applyTransport(s, 'closed')
      expect(phase(s)).toBe('unconfirmed')
    },
  )

  test('an idle failure is not "unconfirmed" just because the socket dropped', () => {
    expect(phase(applyTransport(failed(), 'closed'))).toBe('idle')
  })

  test('an HTTP error shows the server message and allows another try', () => {
    let s = applyRetryRequested(failed(), STEP, 1, T)
    s = applyRetryResult(
      s,
      STEP,
      1,
      { ok: false, status: 0, code: 'NETWORK', message: 'no server' },
      T,
    )
    expect(selectFailures(s, T)[0]).toMatchObject({
      phase: 'error',
      message: 'no server',
    })
    s = applyRetryRequested(s, STEP, 1, T + 1000)
    expect(phase(s)).toBe('requested')
  })

  test('a 422 turns the card into needs service, whatever the event said', () => {
    let s = applyRetryRequested(failed(), STEP, 1, T)
    s = applyRetryResult(
      s,
      STEP,
      1,
      {
        ok: false,
        status: 422,
        code: 'NOT_RETRYABLE',
        message: 'retrying will not fix it',
      },
      T,
    )
    expect(selectFailures(s, T)[0]).toMatchObject({
      phase: 'needs_service',
      message: 'retrying will not fix it',
    })
  })

  test("someone else's retry shows as queued, with no click here", () => {
    const s = fold([{ ...refused2, seq: 19 }], failed())
    expect(selectFailures(s, T)[0]).toMatchObject({
      phase: 'queued',
      retriedElsewhere: true,
    })
  })

  test('R12.7: asking for a retry never moves the timeline', () => {
    const before = failed()
    let s = applyRetryRequested(before, STEP, 1, T)
    s = applyRetryResult(s, STEP, 1, ok, T)
    expect(selectTracks(s)).toEqual(selectTracks(before))
  })

  test('a second failure of the retried step needs action again', () => {
    let s = applyRetryRequested(failed(), STEP, 1, T)
    s = applyRetryResult(s, STEP, 1, ok, T)
    const failed1 = CLEAN.find((e) => e.seq === 17)!
    s = fold(
      [
        dispatch2,
        { ...dispatch2, seq: 20, type: 'step.started' },
        { ...failed1, seq: 21, attempt: 2 },
      ],
      s,
    )
    const [f] = selectFailures(s, T)
    expect(f?.attempt.attempt).toBe(2)
    expect(f?.phase).toBe('idle')
  })
})
