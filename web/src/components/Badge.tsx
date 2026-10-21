// Provided.
const TONE: Record<string, string> = {
  dispatched: 'bg-slate-200 text-slate-800',
  running: 'bg-sky-200 text-sky-900',
  done: 'bg-emerald-200 text-emerald-900',
  failed: 'bg-rose-200 text-rose-900',
}

export function Badge({
  children,
  tone = 'dispatched',
}: {
  children: React.ReactNode
  tone?: string
}) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs ${TONE[tone] ?? TONE.dispatched}`}
    >
      {children}
    </span>
  )
}
