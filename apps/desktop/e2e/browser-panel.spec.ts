// The browser panel end to end: a real native page view over the panel's
// viewport, reading/pointing/measuring in an isolated world, screenshots into
// the workspace, and a refused connection shown as an error.
import { createServer, type Server } from 'node:http'
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { test, expect, sampleWorkspace } from './fixtures'

const PAGE = `<!doctype html><title>Acme</title>
<style>.cta{width:220px;padding:10px 20px;font-size:16px}</style>
<h1>Ship faster</h1><a href="/pricing">Pricing</a>
<button class="cta">Sign up</button>
<script>window.pageSecret = 'only the page knows'</script>`

let server: Server
let base = ''
let workspace = ''

test.beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(req.url === '/pricing' ? '<title>Pricing</title><h1>Plans</h1>' : PAGE)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const addr = server.address()
  base = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}/`
  // A copy, so screenshots don't land in the repo's example.
  workspace = path.join(mkdtempSync(path.join(tmpdir(), 'codeswim-browser-')), 'ws')
  cpSync(sampleWorkspace, workspace, { recursive: true })
})

test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  rmSync(path.dirname(workspace), { recursive: true, force: true })
})

async function openWorkspace(electronApp: ElectronApplication, window: Page): Promise<void> {
  await electronApp.evaluate(async ({ dialog }, ws) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [ws] })
  }, workspace)
  await window.waitForSelector('.start-screen', { timeout: 10_000 })
  await window.click('.start-screen-actions button.secondary')
  await window.waitForSelector('.browser-toggle', { timeout: 15_000 })
}

/** The page view main laid over the panel: its bounds and visibility. */
async function pageView(electronApp: ElectronApplication): Promise<{
  visible: boolean
  bounds: { x: number; y: number; width: number; height: number }
} | null> {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const view = BrowserWindow.getAllWindows()[0].contentView.children[0] as
      (Electron.View & { getVisible(): boolean }) | undefined
    return view ? { visible: view.getVisible(), bounds: view.getBounds() } : null
  })
}

/**
 * Run code in the page's own world (not the isolated one), as if from a user
 * gesture: Chromium won't let Back return past a navigation a script started
 * without one.
 */
async function inPage<T>(electronApp: ElectronApplication, code: string): Promise<T> {
  return electronApp.evaluate(({ webContents }, code) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith('http'))
    if (!wc) throw new Error('no page')
    return wc.executeJavaScript(code, true)
  }, code) as Promise<T>
}

/** A local port nothing listens on. */
async function closedPort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  const addr = s.address()
  await new Promise<void>((r) => s.close(() => r()))
  return typeof addr === 'object' && addr ? addr.port : 9
}

test('opens a page over the panel, reads it, points at it and screenshots it', async ({
  electronApp,
  window
}) => {
  await openWorkspace(electronApp, window)
  await window.click('.browser-toggle')
  await expect(window.locator('.browser-empty')).toBeVisible()

  await window.fill('.browser-address', base.replace('http://', ''))
  await window.press('.browser-address', 'Enter')
  await expect(window.locator('.browser-address')).toHaveValue(base, { timeout: 10_000 })
  await expect(window.locator('.browser-empty')).toHaveCount(0)

  // The native view sits exactly over the viewport.
  const rect = await window.locator('.browser-viewport').evaluate((el) => {
    const r = el.getBoundingClientRect()
    return {
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height)
    }
  })
  await expect.poll(async () => (await pageView(electronApp))?.bounds).toEqual(rect)
  expect((await pageView(electronApp))?.visible).toBe(true)

  const outline = await window.evaluate(() => window.api.browserInspect())
  expect(outline.title).toBe('Acme')
  const signUp = outline.elements.find((e) => e.text === 'Sign up')
  expect(signUp?.role).toBe('button')
  expect(signUp?.box.width).toBe(220)
  expect(JSON.stringify(outline)).not.toContain('only the page knows')

  const pointed = await window.evaluate(() => window.api.browserPoint('sign up'))
  expect(pointed[0]).toMatchObject({ found: true, element: { text: 'Sign up' } })
  expect(
    await inPage<number>(electronApp, `document.querySelectorAll('codeswim-ring').length`)
  ).toBe(1)
  // The isolated world's helper is invisible to the page's own scripts.
  expect(await inPage<string>(electronApp, 'typeof window.__codeswim')).toBe('undefined')

  const measured = await window.evaluate(() => window.api.browserMeasure(['Pricing', 'nope']))
  expect(measured.map((m) => m.found)).toEqual([true, false])

  const ws = workspace
  const shot = await window.evaluate((root) => window.api.browserScreenshot(root), ws)
  expect(shot.path).toMatch(/^\.codeswim\/browser\/screenshot-.*\.png$/)
  expect(shot.width).toBeGreaterThan(100)
  expect(existsSync(path.join(ws, shot.path))).toBe(true)
  expect(existsSync(path.join(ws, '.codeswim', 'browser', '.gitignore'))).toBe(true)

  // Links navigate inside the panel; Back comes back.
  await inPage(electronApp, `document.querySelector('a').click()`)
  await expect(window.locator('.browser-address')).toHaveValue(`${base}pricing`)
  await window.click('.browser-bar button[aria-label="Back"]')
  await expect(window.locator('.browser-address')).toHaveValue(base)

  // Hiding the panel hides the page; showing it brings the same page back.
  await window.click('.browser-toggle')
  await expect.poll(async () => (await pageView(electronApp))?.visible).toBe(false)
  await window.click('.browser-toggle')
  await expect.poll(async () => (await pageView(electronApp))?.visible).toBe(true)
  await expect(window.locator('.browser-address')).toHaveValue(base)
})

test('a page that does not load says why, and refuses non-web addresses', async ({
  electronApp,
  window
}) => {
  await openWorkspace(electronApp, window)
  await window.click('.browser-toggle')
  await window.fill('.browser-address', `localhost:${await closedPort()}`)
  await window.press('.browser-address', 'Enter')
  await expect(window.locator('.browser-error')).toContainText("didn't load", { timeout: 10_000 })
  await expect(window.locator('.browser-error-detail')).toContainText('ERR_CONNECTION_REFUSED')
  expect((await pageView(electronApp))?.visible).toBe(false)

  await window.fill('.browser-address', 'file:///etc/passwd')
  await window.press('.browser-address', 'Enter')
  await expect(window.locator('.browser-error').first()).toContainText('Only http and https')
})
