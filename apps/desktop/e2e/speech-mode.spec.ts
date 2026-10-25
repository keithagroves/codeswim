// Speech mode's sound-wave button: from the chat it opens the whiteboard and
// replaces the chat box with the listening bar; End brings the box back.
//
// With the speech model fetched (scripts/fetch-models.mjs, as in a packaged
// build) it goes straight for the microphone, which the test refuses, so the
// bar says where to allow it. Without it, the bar offers the download first.
// Listening itself isn't run here: it needs a microphone.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { test, expect, sampleWorkspace } from './fixtures'

const bundled = existsSync(
  path.resolve(__dirname, '..', 'models', 'onnx-community', 'whisper-base.en', 'onnx')
)

test('the sound-wave button starts speech mode, and End stops it', async ({
  electronApp,
  window
}) => {
  await electronApp.evaluate(async ({ dialog, ipcMain }, ws) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [ws] })
    ipcMain.removeHandler('mic:access')
    ipcMain.handle('mic:access', () => false)
  }, sampleWorkspace)
  await window.waitForSelector('.start-screen', { timeout: 10_000 })
  await window.click('.start-screen-actions button.secondary')
  await window.waitForSelector('g.node:has-text("API Gateway")', { timeout: 15_000 })

  await window.click('.chat-panel button[aria-label="Start speech mode"]')
  await expect(window.locator('.whiteboard')).toBeVisible()
  await expect(window.locator('.chat-panel .chat-input')).toHaveCount(0)
  await expect(window.locator('.whiteboard-strip .speech-mode-btn')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  const bar = bundled
    ? window.locator('.chat-panel .speech-bar.is-error')
    : window.locator('.chat-panel .speech-bar.is-offer')
  await expect(bar).toContainText(bundled ? 'System Settings' : '77 MB')

  await bar.locator(`button:has-text("${bundled ? 'End' : 'Cancel'}")`).click()
  await expect(window.locator('.chat-panel .speech-bar')).toHaveCount(0)
  await expect(window.locator('.chat-panel .chat-input')).toBeVisible()
})
