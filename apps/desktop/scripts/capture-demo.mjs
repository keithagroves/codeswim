// Drive the built app through a short navigation demo and capture frames as
// PNGs (assembled into media/codeswim-demo.gif by ffmpeg afterwards).
//
// Storyboard: Start screen → open the sample-architecture fixture → overview
// diagram → drill Billing → Charge flow → a source-leaf explanation → home.
//
// Run from apps/desktop:  node scripts/capture-demo.mjs
import { _electron as electron } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { rmSync, mkdirSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(here, '..') // apps/desktop
const repoRoot = path.resolve(appDir, '..', '..')
const workspace = path.join(repoRoot, 'examples', 'sample-architecture')

const framesDir = path.join(appDir, 'out', 'demo-frames')
rmSync(framesDir, { recursive: true, force: true })
mkdirSync(framesDir, { recursive: true })

// Throwaway profile → no real recent projects leak into the Start screen.
const userDataDir = mkdtempSync(path.join(tmpdir(), 'codeswim-demo-'))

const FPS = 12
const FRAME_MS = Math.round(1000 / FPS)
let frame = 0

const app = await electron.launch({
  args: [appDir, `--user-data-dir=${userDataDir}`],
  cwd: appDir,
  env: { ...process.env, NODE_ENV: 'production' }
})

try {
  const page = await app.firstWindow({ timeout: 20000 })
  await page.waitForLoadState('domcontentloaded')

  // Pin a clean 1200×800 content area for a consistent capture size.
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setContentSize(1200, 800)
    w.center()
  })

  // Mock the native folder picker so "Open folder…" loads the fixture.
  await app.evaluate(async ({ dialog }, ws) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [ws] })
  }, workspace)

  const grab = async () => {
    await page.screenshot({
      path: path.join(framesDir, `frame${String(frame++).padStart(4, '0')}.png`)
    })
  }
  // Hold the current state for `seconds`, capturing at FPS.
  const hold = async (seconds) => {
    const n = Math.max(1, Math.round(seconds * FPS))
    for (let i = 0; i < n; i++) {
      const t0 = Date.now()
      await grab()
      const dt = Date.now() - t0
      if (dt < FRAME_MS) await page.waitForTimeout(FRAME_MS - dt)
    }
  }
  // Click a mermaid node by its visible label, falling back to window.navigate.
  const clickNode = async (label, fallbackTarget) => {
    const node = page.locator(`g.node:has-text("${label}")`).first()
    try {
      await node.click({ timeout: 3000 })
    } catch {
      await page.evaluate((t) => window.navigate?.(t), fallbackTarget)
    }
  }

  await page.waitForSelector('.start-screen', { timeout: 10000 })
  await hold(1.4) // Start screen

  await page.click('.start-screen-actions button.secondary') // Open folder…
  await page.waitForSelector('g.node:has-text("API Gateway")', { timeout: 15000 })
  await hold(2.4) // Overview diagram

  await clickNode('Billing Service', './billing.md')
  await page.waitForSelector('g.node:has-text("Refund Service")', { timeout: 10000 })
  await hold(2.2) // Billing subsystem

  await clickNode('Charge Service', './charge-flow.md')
  await page.waitForSelector('g.node:has-text("Payment Provider")', { timeout: 10000 })
  await hold(2.2) // Charge flow

  await clickNode('Persist Charge', './src/billing/charge.ts')
  await page.waitForTimeout(600) // source-leaf explanation renders (ReadView)
  await hold(3.0) // Explanation for charge.ts

  await page.click('button[title="Overview"]') // ⌂ home
  await page.waitForSelector('g.node:has-text("Billing Service")', { timeout: 10000 })
  await hold(1.6) // Back at overview

  console.log(`captured ${frame} frames @ ${FPS}fps → ${framesDir}`)
} finally {
  await app.close()
  rmSync(userDataDir, { recursive: true, force: true })
}
