// QA-18: a reply that is not a snapshot must never reach the state layer.
import { afterEach, describe, expect, test, vi } from 'vitest'
import { fetchSnapshot } from '../src/lib/api'

const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchSnapshot', () => {
  test('rejects a 404', async () => {
    vi.stubGlobal('fetch', reply(404, { error: 'no such run' }))
    await expect(fetchSnapshot('r-9')).rejects.toThrow('HTTP 404')
  })

  test('rejects a 200 that is not shaped like a snapshot', async () => {
    vi.stubGlobal('fetch', reply(200, { seq: 3, run: { id: 'r-1' } }))
    await expect(fetchSnapshot('r-1')).rejects.toThrow('unexpected shape')
  })

  test('returns a real snapshot', async () => {
    const snap = { seq: 3, run: { id: 'r-1', status: 'running', steps: [] } }
    vi.stubGlobal('fetch', reply(200, snap))
    await expect(fetchSnapshot('r-1')).resolves.toEqual(snap)
  })
})
