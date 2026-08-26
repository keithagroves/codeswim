import { test, expect, sampleWorkspace } from './fixtures'

// "Open folder…" goes through the native dialog (main/index.ts's `pick-folder`
// handler), so we stub dialog.showOpenDialog in the main process rather than
// try to drive the OS picker — same technique scripts/capture-demo.mjs uses.
test('opens a folder chosen via the native picker into its overview diagram', async ({
  electronApp,
  window
}) => {
  await electronApp.evaluate(async ({ dialog }, ws) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [ws] })
  }, sampleWorkspace)

  await window.waitForSelector('.start-screen', { timeout: 10_000 })
  await window.click('.start-screen-actions button.secondary')

  await window.waitForSelector('g.node:has-text("API Gateway")', { timeout: 15_000 })
  await expect(window.locator('g.node:has-text("API Gateway")')).toBeVisible()
})

test('does nothing when the native picker is canceled', async ({ electronApp, window }) => {
  await electronApp.evaluate(async ({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
  })

  await window.waitForSelector('.start-screen', { timeout: 10_000 })
  await window.click('.start-screen-actions button.secondary')

  // No workspace loaded — the start screen stays put.
  await window.waitForTimeout(500)
  await expect(window.locator('.start-screen')).toBeVisible()
})
