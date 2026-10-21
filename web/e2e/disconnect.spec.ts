// Gate 3. The simulator is running with SOCKET_KILL_MS set, so the socket goes
// away mid-run. See scripts/check-disconnect.sh.
import { expect, test } from '@playwright/test'

test('gate 3: a dropped connection is admitted, not hidden', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByTestId('start-run').click()
  await expect(page.getByTestId('bar').first()).toBeVisible({ timeout: 20_000 })

  // The server drops every socket on a timer, so this will happen on its own.
  const banner = page.getByTestId('connection-banner')
  await expect(
    banner,
    'the screen kept claiming to be live after the socket went away',
  ).toBeVisible({
    timeout: 25_000,
  })
  await expect(banner).toHaveAttribute('data-status', /stale|gap/)
})

test('gate 3b: the run still finishes correctly across reconnects', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByTestId('start-run').click()
  await expect(page.getByTestId('run-status')).toContainText('completed', {
    timeout: 60_000,
  })

  const drawn = await page.getByTestId('bar').evaluateAll((nodes) =>
    nodes.map((n) => ({
      step: n.getAttribute('data-step')!,
      status: n.getAttribute('data-status')!,
    })),
  )
  expect(
    drawn.length,
    'events lost across a reconnect never made it back',
  ).toBe(7)
  expect(drawn.every((b) => b.status === 'done')).toBe(true)
})
