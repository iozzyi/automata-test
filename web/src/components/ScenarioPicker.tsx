// Testing control: switch the simulator between failure and network scenarios
// without restarting it. Talks to the simulator-only PUT /config; a real lab
// would have nothing like it, which is why it is labelled as it is.
import { useEffect, useState } from 'react'
import { getConfig, setConfig } from '../lib/api'
import type { SimConfig } from '../lib/api'

const OFF: SimConfig = {
  fail_step: '',
  reorder_pct: 0,
  duplicate_pct: 0,
  socket_kill_ms: 0,
  socket_reject_ms: 0,
  replay_buffer_size: 64,
}

interface Scenario {
  id: string
  label: string
  /** What to look for, shown under the picker. */
  hint: string
  config: SimConfig
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'clean',
    label: 'Clean run',
    hint: 'Everything works: seven green bars in about 14 s. Pick this to reset the simulator (settings made here survive `docker compose up -d`).',
    config: OFF,
  },
  {
    id: 'incubator',
    label: 'Incubator fault (retryable)',
    hint: 'warm_reagent_plate fails once. Retry it from the card.',
    config: { ...OFF, fail_step: 'warm_reagent_plate' },
  },
  {
    id: 'plate-reader',
    label: 'Plate reader needs service',
    hint: 'read_plate fails and cannot be retried. The run stays blocked.',
    config: { ...OFF, fail_step: 'read_plate' },
  },
  {
    id: 'liquid-handler',
    label: 'Liquid handler fault (retryable)',
    hint: 'fill_buffer_plate fails while other steps are still running.',
    config: { ...OFF, fail_step: 'fill_buffer_plate' },
  },
  {
    id: 'chaos',
    label: 'Network: reordered and duplicated events',
    hint: 'The timeline should still end the same as a clean run.',
    config: { ...OFF, reorder_pct: 30, duplicate_pct: 20 },
  },
  {
    id: 'dropped',
    label: 'Network: connection drops every 4 s',
    hint: 'The banner says when the screen is not being updated; nothing is lost.',
    config: { ...OFF, socket_kill_ms: 4000 },
  },
  {
    id: 'gap',
    label: 'Network: unrecoverable gap',
    hint: 'Long outages and a tiny buffer: the banner admits part of the run was not recorded.',
    config: {
      ...OFF,
      socket_kill_ms: 2500,
      socket_reject_ms: 6000,
      replay_buffer_size: 2,
    },
  },
]

const same = (a: SimConfig, b: SimConfig) =>
  (Object.keys(OFF) as (keyof SimConfig)[]).every((k) => a[k] === b[k])

export function ScenarioPicker() {
  const [config, setCurrent] = useState<SimConfig | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // "Applied" is news for a moment; then go back to what to look for.
  useEffect(() => {
    if (!message) return
    const t = setTimeout(() => setMessage(null), 4000)
    return () => clearTimeout(t)
  }, [message])

  useEffect(() => {
    getConfig()
      .then(setCurrent)
      .catch(() => setMessage("Couldn't read the simulator's settings."))
  }, [])

  const active = config
    ? (SCENARIOS.find((s) => same(s.config, config)) ?? null)
    : null

  const choose = async (id: string) => {
    const scenario = SCENARIOS.find((s) => s.id === id)
    if (!scenario) return
    setBusy(true)
    try {
      setCurrent(await setConfig(scenario.config))
      setMessage(
        'Applied. Network settings act now; failures and the buffer size apply to the next run.',
      )
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'The change was not applied.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-testid="scenario-picker"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-700"
    >
      <label htmlFor="scenario" className="font-medium">
        Simulator scenario <span className="font-normal">(testing only)</span>
      </label>
      <select
        id="scenario"
        disabled={busy || config === null}
        value={active?.id ?? 'custom'}
        onChange={(e) => void choose(e.target.value)}
        className="rounded border border-slate-300 bg-white px-1.5 py-1"
      >
        {SCENARIOS.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
        {!active && config && (
          <option value="custom">Custom (set outside the page)</option>
        )}
      </select>
      <span aria-live="polite" className="text-slate-600">
        {message ?? active?.hint ?? ''}
      </span>
    </div>
  )
}
