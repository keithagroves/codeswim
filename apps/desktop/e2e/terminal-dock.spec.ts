// The terminal panel along the bottom of the main column: Ctrl+` and the
// Terminal icon toggle it, hiding keeps the shell alive, the top edge resizes
// it, it maximizes over the view, and it comes back the same after a reload.
import type { ElectronApplication, Page } from 'playwright-core'
import { test, expect, sampleWorkspace } from './fixtures'

async function openWorkspace(electronApp: ElectronApplication, window: Page): Promise<void> {
  await electronApp.evaluate(async ({ dialog }, ws) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [ws] })
  }, sampleWorkspace)
  await window.waitForSelector('.start-screen', { timeout: 10_000 })
  await window.click('.start-screen-actions button.secondary')
  await window.waitForSelector('g.node:has-text("API Gateway")', { timeout: 15_000 })
}

const box = (
  window: Page,
  selector: string
): Promise<{ top: number; bottom: number; height: number }> =>
  window.locator(selector).evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) }
  })

test('Ctrl+` toggles a terminal along the bottom that survives being hidden', async ({
  electronApp,
  window
}) => {
  await openWorkspace(electronApp, window)
  const dock = window.locator('.terminal-dock')
  await expect(dock).toHaveCount(0)

  await window.keyboard.press('Control+Backquote')
  await expect(dock).toBeVisible()
  await expect(window.locator('.terminal-dock .terminal-instance canvas')).toHaveCount(1, {
    timeout: 10_000
  })
  // Under the view, at the bottom of the main column, not in the side panel.
  const [content, panel, column] = await Promise.all([
    box(window, '.main-column > .content'),
    box(window, '.terminal-dock'),
    box(window, '.main-column')
  ])
  expect(panel.top).toBeGreaterThanOrEqual(content.bottom - 1)
  expect(panel.bottom).toBe(column.bottom)
  expect(panel.height).toBe(260)
  await expect(window.locator('.side-panel .terminal-panel-outer')).toHaveCount(0)
  // The cursor goes into the shell.
  await expect
    .poll(() => window.evaluate(() => !!document.activeElement?.closest('.terminal-dock')))
    .toBe(true)

  // Hidden, not destroyed: the same shell is there when it comes back.
  await window.keyboard.press('Control+Backquote')
  await expect(dock).toBeHidden()
  await window.click(
    '.activity-bar button[aria-label="Terminal"], .activity-bar button[title="Terminal"]'
  )
  await expect(dock).toBeVisible()
  await expect(window.locator('.terminal-dock .terminal-instance')).toHaveCount(1)

  // Drag the top edge up 100px.
  const edge = await box(window, '.terminal-dock-resizer')
  const x = (await window.locator('.terminal-dock').boundingBox())!.x + 200
  await window.mouse.move(x, edge.top + 3)
  await window.mouse.down()
  await window.mouse.move(x, edge.top - 97, { steps: 5 })
  await window.mouse.up()
  await expect.poll(async () => (await box(window, '.terminal-dock')).height).toBe(360)

  // Maximized, it takes the column and the view steps aside.
  await window.click('.terminal-dock-btn[aria-label="Maximize panel"]')
  await expect(window.locator('.main-column > .content')).toBeHidden()
  await window.click('.terminal-dock-btn[aria-label="Restore panel size"]')
  await expect(window.locator('.main-column > .content')).toBeVisible()
  expect((await box(window, '.terminal-dock')).height).toBe(360)

  // Open state and height survive a reload.
  await window.reload()
  await window.waitForSelector('.start-screen, .main-column', { timeout: 15_000 })
  await openWorkspace(electronApp, window)
  await expect(dock).toBeVisible({ timeout: 15_000 })
  expect((await box(window, '.terminal-dock')).height).toBe(360)

  await window.click('.terminal-dock-btn[aria-label="Hide the terminal"]')
  await expect(dock).toBeHidden()
})
