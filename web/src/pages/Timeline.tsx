// Provided. One lane per device, one bar per attempt. It renders exactly what
// selectTracks returns and knows nothing else.
//
// A bar with no end is still running: it is drawn to the current time and
// marked, rather than given an end the instrument has not reported.
//
// Bars can be clicked (or focused and Enter pressed) to show that attempt's
// details; the test ids and data-* attributes are unchanged.
import { ticks, timeScale } from '../lib/scale'
import type { Track } from '../lib/runState'
import { DEVICES } from '../lib/types'

const LANE_H = 44
const LABEL_W = 160
const WIDTH = 900

export function Timeline({
  tracks,
  now,
  t0,
  selected = null,
  onSelect,
}: {
  tracks: Track[]
  now: number
  t0: number | null
  /** `${stepId}#${attempt}` of the bar whose details are shown. */
  selected?: string | null
  onSelect?: (stepId: string, attempt: number) => void
}) {
  const origin = t0 ?? now
  const x = timeScale(origin, now, WIDTH)
  const byDevice = new Map(tracks.map((t) => [t.deviceId, t]))

  return (
    <div data-testid="timeline" className="overflow-x-auto">
      <div style={{ width: WIDTH + LABEL_W }}>
        <div className="flex border-b border-slate-300">
          <div className="shrink-0" style={{ width: LABEL_W }} />
          <div className="relative h-5" style={{ width: WIDTH }}>
            {ticks(origin, now).map((t) => (
              <span
                key={t}
                className="absolute top-0 -translate-x-1/2 text-[10px] text-slate-400 tabular-nums"
                style={{ left: x(t) }}
              >
                {Math.round((t - origin) / 1000)}s
              </span>
            ))}
          </div>
        </div>
        {DEVICES.map((device) => {
          const track = byDevice.get(device)
          return (
            <div
              key={device}
              data-testid="lane"
              data-device={device}
              className="flex items-center border-b border-slate-200"
            >
              <div
                className="shrink-0 pr-2 text-xs text-slate-600"
                style={{ width: LABEL_W }}
              >
                {device}
              </div>
              <div
                className="relative overflow-hidden"
                style={{ width: WIDTH, height: LANE_H }}
              >
                {(track?.attempts ?? []).map((a) => {
                  const start = a.startedAt ?? a.endedAt
                  if (start === null) return null
                  const end = a.endedAt ?? now
                  const left = x(start)
                  const width = Math.max(Math.min(x(end), WIDTH) - left, 3)
                  const key = `${a.stepId}#${a.attempt}`
                  const select = onSelect
                    ? () => onSelect(a.stepId, a.attempt)
                    : undefined
                  return (
                    <div
                      key={key}
                      data-testid="bar"
                      data-step={a.stepId}
                      data-attempt={a.attempt}
                      data-device={a.deviceId}
                      data-status={a.status}
                      data-refused={a.refused ? 'true' : 'false'}
                      data-start={String(start)}
                      data-end={a.endedAt === null ? '' : String(a.endedAt)}
                      title={`${a.stepId} (attempt ${a.attempt}) — ${a.status}`}
                      role={select ? 'button' : undefined}
                      tabIndex={select ? 0 : undefined}
                      aria-pressed={select ? selected === key : undefined}
                      onClick={select}
                      onKeyDown={
                        select
                          ? (ev) => {
                              if (ev.key === 'Enter' || ev.key === ' ') {
                                ev.preventDefault()
                                select()
                              }
                            }
                          : undefined
                      }
                      className={`absolute top-2 h-7 rounded text-[10px] leading-7 px-1 overflow-hidden whitespace-nowrap ${barTone(a.status)} ${select ? 'cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900' : ''} ${selected === key ? 'ring-2 ring-slate-900 ring-offset-1' : ''}`}
                      style={{ left, width }}
                    >
                      {a.stepId}
                      {a.attempt > 1 ? ` #${a.attempt}` : ''}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function barTone(status: string): string {
  switch (status) {
    case 'running':
      return 'bg-sky-300 text-sky-950 [background-image:repeating-linear-gradient(45deg,transparent,transparent_5px,rgba(255,255,255,.45)_5px,rgba(255,255,255,.45)_10px)]'
    case 'done':
      return 'bg-emerald-300 text-emerald-950'
    case 'failed':
      return 'bg-rose-400 text-rose-950'
    default:
      return 'bg-slate-300 text-slate-800'
  }
}
