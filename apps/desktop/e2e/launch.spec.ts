import { test, expect } from './fixtures'

test('boots into the start screen without console or page errors', async ({ window }) => {
  const errors: string[] = []
  window.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  window.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))

  await window.waitForSelector('.start-screen', { timeout: 10_000 })
  await expect(window.locator('.start-screen-actions button.primary')).toContainText('New project')
  await expect(window.locator('.start-screen-actions button.secondary')).toContainText('Open folder')
  await expect(window.locator('.start-screen-demo')).toContainText('try the demo project')

  expect(errors).toEqual([])
})

test('exposes the window.api preload bridge', async ({ window }) => {
  const hasApiBridge = await window.evaluate(() => typeof window.api === 'object')
  expect(hasApiBridge).toBe(true)
})
