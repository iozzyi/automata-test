import { useEffect, useState } from 'react'

/** Copies text to the clipboard and says whether it worked. */
export function CopyButton({
  text,
  label,
  testId,
}: {
  text: string
  label: string
  testId: string
}) {
  const [result, setResult] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    if (result === 'idle') return
    const t = setTimeout(() => setResult('idle'), 2000)
    return () => clearTimeout(t)
  }, [result])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setResult('copied')
    } catch {
      setResult('failed')
    }
  }

  return (
    <button
      type="button"
      data-testid={testId}
      onClick={() => void copy()}
      className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
    >
      {result === 'copied'
        ? 'Copied'
        : result === 'failed'
          ? 'Copy failed: select the text instead'
          : label}
    </button>
  )
}
