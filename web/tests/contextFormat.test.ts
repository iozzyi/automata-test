// R13, R14.4: how an instrument's report is labelled and formatted.
import { describe, expect, test } from 'vitest'
import {
  errorJson,
  formatScalar,
  serviceReport,
  tidyLabel,
  valueKind,
} from '../src/lib/contextFormat'
import type { Attempt } from '../src/lib/runState'

describe('tidyLabel', () => {
  test.each([
    // Every key the simulator's three faults send.
    ['target_c', 'Target (°C)'],
    ['actual_c', 'Actual (°C)'],
    ['tolerance_c', 'Tolerance (°C)'],
    ['elapsed_s', 'Elapsed (s)'],
    ['labware', 'Labware'],
    ['door_cycles', 'Door cycles'],
    ['channel', 'Channel'],
    ['tip_box', 'Tip box'],
    ['wells_remaining', 'Wells remaining'],
    ['volume_ul', 'Volume (µL)'],
    ['last_calibrated', 'Last calibrated'],
    ['max_age_days', 'Max age (days)'],
    ['filter_set', 'Filter set'],
    ['service_ticket', 'Service ticket'],
    // Keys from an instrument nobody has seen yet.
    ['spin_ms', 'Spin (ms)'],
    ['humidity_pct', 'Humidity (%)'],
    ['lastServiceDate', 'Last service date'],
    ['rotor-id', 'Rotor id'],
    ['c', 'C'], // a bare suffix is not a unit
    ['_s', 'S'],
  ])('%s → %s', (key, label) => {
    expect(tidyLabel(key)).toBe(label)
  })
})

describe('formatScalar', () => {
  test.each([
    [31.2, '31.2'],
    [0, '0'],
    [true, 'Yes'],
    [false, 'No'],
    [null, '—'],
    [undefined, '—'],
    ['', '(empty)'],
    ['PLT-00421', 'PLT-00421'],
  ])('%j → %s', (v, out) => {
    expect(formatScalar(v)).toBe(out)
  })
})

test('valueKind', () => {
  expect(valueKind([1])).toBe('list')
  expect(valueKind({ a: 1 })).toBe('object')
  expect(valueKind(null)).toBe('scalar')
  expect(valueKind('x')).toBe('scalar')
})

const failure: Attempt = {
  stepId: 'read_plate',
  attempt: 1,
  deviceId: 'plate-reader-1',
  status: 'failed',
  refused: false,
  startedAt: Date.UTC(2026, 8, 1, 15, 51, 20),
  endedAt: Date.UTC(2026, 8, 1, 15, 51, 22),
  error: {
    code: 'CALIBRATION_EXPIRED',
    instrument: 'plate-reader-1',
    detail: 'last calibration was 41 days ago; limit is 30',
    retryable: false,
    context: {
      last_calibrated: '2026-07-22',
      max_age_days: 30,
      service_ticket: 'SVC-3312',
      filters: [{ name: 'FITC', ok: true }],
      empty: {},
    },
  },
}

describe('serviceReport', () => {
  test('has everything a service engineer needs, nested values included', () => {
    expect(serviceReport('r-1', failure)).toBe(
      [
        'Service report: plate-reader-1',
        'Run: r-1',
        'Step: read_plate (attempt 1)',
        'Failed at: 2026-09-01T15:51:22.000Z',
        'Error code: CALIBRATION_EXPIRED',
        'Detail: last calibration was 41 days ago; limit is 30',
        'Retryable: No',
        'Instrument details:',
        '  Last calibrated [last_calibrated]: 2026-07-22',
        '  Max age (days) [max_age_days]: 30',
        '  Service ticket [service_ticket]: SVC-3312',
        '  Filters [filters]:',
        '    1 [1]:',
        '      Name [name]: FITC',
        '      Ok [ok]: Yes',
        '  Empty [empty]: (empty)',
      ].join('\n'),
    )
  })

  test('copes with a failure that carried no error', () => {
    expect(serviceReport(null, { ...failure, error: null })).toContain(
      'no error details',
    )
  })
})

test('errorJson keeps every key', () => {
  expect(JSON.parse(errorJson(failure.error!))).toEqual(failure.error)
})
