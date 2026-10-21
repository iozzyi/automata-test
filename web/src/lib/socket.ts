// Provided. Connection mechanics only: open, hand frames over, reconnect with
// backoff. It holds no state and makes no decisions.
//
// The one thing it does not decide is *where to resume from*. It asks, on every
// connection attempt, so the answer comes from your run state rather than from
// here.
import { wsURL } from './api'

export interface SocketHandlers {
  /** Called for every frame off the wire, already JSON-parsed. */
  onMessage: (msg: unknown) => void
  onOpen: () => void
  onClose: () => void
  /** Asked before each connection attempt. Return the last seq you hold. */
  resumeFrom: () => number
}

export function connect(runId: string, h: SocketHandlers): () => void {
  let ws: WebSocket | null = null
  let stopped = false
  let backoff = 250
  let timer: ReturnType<typeof setTimeout> | undefined

  const open = () => {
    if (stopped) return
    ws = new WebSocket(wsURL(runId, h.resumeFrom()))
    ws.onopen = () => {
      backoff = 250
      h.onOpen()
    }
    ws.onmessage = (ev) => {
      try {
        h.onMessage(JSON.parse(ev.data as string))
      } catch {
        /* a frame we cannot parse is not a frame we can act on */
      }
    }
    ws.onclose = () => {
      h.onClose()
      if (stopped) return
      timer = setTimeout(open, backoff)
      backoff = Math.min(backoff * 2, 4000)
    }
    ws.onerror = () => ws?.close()
  }

  open()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    ws?.close()
  }
}
