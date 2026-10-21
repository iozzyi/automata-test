// Gates 1 and 2, against a live run.
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const DEVICES = ['liquid-handler-1', 'incubator-1', 'plate-reader-1']

async function startRunAndWait(page: Page) {
  await page.goto('/')
  await page.getByTestId('start-run').click()
  await expect(page.getByTestId('run-status')).toContainText('completed', {
    timeout: 45_000,
  })
}

async function bars(page: Page) {
  return page.getByTestId('bar').evaluateAll((nodes) =>
    nodes.map((n) => ({
      step: n.getAttribute('data-step')!,
      attempt: Number(n.getAttribute('data-attempt')),
      device: n.getAttribute('data-device')!,
      status: n.getAttribute('data-status')!,
      start: Number(n.getAttribute('data-start')),
      end:
        n.getAttribute('data-end') === ''
          ? null
          : Number(n.getAttribute('data-end')),
    })),
  )
}

test('the timeline shows every step of a completed run', async ({ page }) => {
  await startRunAndWait(page)
  const drawn = await bars(page)
  expect(drawn.length, 'seven steps should be on the timeline').toBe(7)
  expect(drawn.every((b) => b.status === 'done')).toBe(true)
})

test('gate 1: no device runs two steps at once', async ({ page }) => {
  await startRunAndWait(page)
  const drawn = await bars(page)
  for (const device of DEVICES) {
    const spans = drawn
      .filter((b) => b.device === device)
      .map((b) => [b.start, b.end ?? Number.POSITIVE_INFINITY] as const)
      .sort((a, b) => a[0] - b[0])
    for (let i = 1; i < spans.length; i++) {
      expect(
        spans[i]![0],
        `${device} shows overlapping bars -- an instrument cannot run two steps at once`,
      ).toBeGreaterThanOrEqual(spans[i - 1]![1])
    }
  }
})

test('gate 2: a running step is not given an end it has not reported', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByTestId('start-run').click()

  // Catch the run mid-flight.
  await expect(page.getByTestId('bar').first()).toBeVisible({ timeout: 20_000 })
  const midRun = await bars(page)
  const running = midRun.filter((b) => b.status === 'running')
  expect(
    running.length,
    'something should be running a few seconds in',
  ).toBeGreaterThan(0)
  for (const b of running) {
    expect(
      b.end,
      `${b.step} is running but the timeline gave it an end`,
    ).toBeNull()
  }
})
