// Turning what an instrument reported into something a person can read.
//
// `context` is different for every instrument and every fault, and nothing
// enumerates the keys, so nothing here knows about any particular instrument.
// Labels are tidied by rule and the raw key is always shown beside them; no
// key is ever dropped. Plain TypeScript, so the tests call straight in.
import type { Attempt } from './runState'
import type { StepError } from './types'

/** Unit suffixes, longest first so `_ms` wins over `_s`. */
const UNITS: [suffix: string, unit: string][] = [
  ['_days', 'days'],
  ['_pct', '%'],
  ['_ms', 'ms'],
  ['_ul', 'µL'],
  ['_ml', 'mL'],
  ['_c', '°C'],
  ['_s', 's'],
]

/** `actual_c` → "Actual (°C)", `door_cycles` → "Door cycles". */
export function tidyLabel(key: string): string {
  let base = key
  let unit: string | null = null
  for (const [suffix, u] of UNITS) {
    if (key.length > suffix.length && key.toLowerCase().endsWith(suffix)) {
      base = key.slice(0, -suffix.length)
      unit = u
      break
    }
  }
  const words = base
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .toLowerCase()
  const label = words.charAt(0).toUpperCase() + words.slice(1)
  return unit ? `${label} (${unit})` : label
}

export type ValueKind = 'list' | 'object' | 'scalar'

export function valueKind(v: unknown): ValueKind {
  if (Array.isArray(v)) return 'list'
  if (typeof v === 'object' && v !== null) return 'object'
  return 'scalar'
}

/** A single value as text. Numbers as sent, booleans as Yes/No, nothing as —. */
export function formatScalar(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (typeof v === 'string') return v === '' ? '(empty)' : v
  if (typeof v === 'number' || typeof v === 'bigint') return String(v)
  return JSON.stringify(v)
}

/** Local wall-clock time, for a person at the bench. */
export function formatClock(ms: number | null): string {
  if (ms === null) return '—'
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function formatIso(ms: number | null): string {
  return ms === null ? 'not reported' : new Date(ms).toISOString()
}

/** Everything a service engineer needs, as plain text to paste into a ticket. */
export function serviceReport(runId: string | null, a: Attempt): string {
  const e = a.error
  const lines = [
    `Service report: ${e?.instrument ?? a.deviceId}`,
    `Run: ${runId ?? 'unknown'}`,
    `Step: ${a.stepId} (attempt ${a.attempt})`,
    `Failed at: ${formatIso(a.endedAt)}`,
  ]
  if (e) {
    lines.push(
      `Error code: ${e.code}`,
      `Detail: ${e.detail}`,
      `Retryable: ${e.retryable ? 'Yes' : 'No'}`,
    )
    const ctx = Object.entries(e.context ?? {})
    if (ctx.length > 0) {
      lines.push('Instrument details:')
      for (const [k, v] of ctx) lines.push(...reportLines(k, v, 1))
    }
  } else {
    lines.push('The instrument reported no error details.')
  }
  return lines.join('\n')
}

function reportLines(key: string, v: unknown, depth: number): string[] {
  const pad = '  '.repeat(depth)
  const head = `${pad}${tidyLabel(key)} [${key}]:`
  const kind = valueKind(v)
  if (kind === 'scalar') return [`${head} ${formatScalar(v)}`]
  const entries =
    kind === 'list'
      ? (v as unknown[]).map((x, i) => [String(i + 1), x] as const)
      : Object.entries(v as Record<string, unknown>)
  if (entries.length === 0) return [`${head} (empty)`]
  return [head, ...entries.flatMap(([k, x]) => reportLines(k, x, depth + 1))]
}

/** The whole error as the instrument sent it, for "Copy JSON". */
export function errorJson(e: StepError): string {
  return JSON.stringify(e, null, 2)
}
