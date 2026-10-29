// The browser panel's page: one sandboxed WebContentsView inside the main
// window (architecture/renderer.md, "Browser panel").
//
// React owns the panel — address bar, buttons, layout — and tells main where
// the viewport is (setBounds); main owns the native view and keeps it over
// that rectangle. Closing the panel hides the view but keeps the page
// running; closing the window destroys it.
//
// Isolation: the view gets no preload, a sandboxed renderer, its own session
// partition (no cookies shared with the app), and every permission request
// denied. Only http(s) loads; popups open in the same view; downloads are
// cancelled. Inspect/point/measure run in an isolated world (browser-page.ts).

import { BrowserWindow, WebContentsView, session, type Rectangle } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type {
  BrowserBounds,
  BrowserState,
  PageMatch,
  PageOutline,
  PageScreenshot
} from '@codeswim/contract'
import {
  PAGE_WORLD_ID,
  isWebUrl,
  measureScript,
  normalizeBrowserUrl,
  outlineScript,
  pointScript,
  screenshotName,
  screenshotsToPrune,
  toMatches,
  toOutline
} from './browser-page'

const PARTITION = 'persist:codeswim-browser'
const SCRIPT_TIMEOUT_MS = 5_000
const RELOAD_TIMEOUT_MS = 15_000
// loadURL resolves on the main frame's load; subresources can still be
// arriving. Callers (the agent especially) get the state once that settles.
const SETTLE_TIMEOUT_MS = 5_000
export const SCREENSHOT_DIR = '.codeswim/browser'

let sessionConfigured = false

function configureSession(): void {
  if (sessionConfigured) return
  sessionConfigured = true
  const ses = session.fromPartition(PARTITION)
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.on('will-download', (event) => event.preventDefault())
}

/** Resolve once the page stops loading (now, if it already has), or after `ms`. */
function stoppedLoading(wc: Electron.WebContents, ms: number): Promise<void> {
  if (!wc.isLoading()) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      wc.removeListener('did-stop-loading', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    wc.once('did-stop-loading', done)
  })
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

export class BrowserHost {
  private view: WebContentsView | null = null
  private owner: BrowserWindow | null = null
  private bounds: BrowserBounds | null = null
  private error: string | null = null

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly emit: (state: BrowserState) => void
  ) {}

  state(): BrowserState {
    const wc = this.view?.webContents
    if (!wc || wc.isDestroyed()) {
      return {
        url: '',
        title: '',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        error: this.error
      }
    }
    return {
      url: wc.getURL(),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      error: this.error
    }
  }

  private changed(): void {
    this.layout()
    this.emit(this.state())
  }

  private ensure(): WebContentsView {
    const window = this.getWindow()
    if (!window || window.isDestroyed()) throw new Error('The app window is not available.')
    if (this.view && this.owner === window && !this.view.webContents.isDestroyed()) return this.view
    this.destroy()
    configureSession()
    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false
      }
    })
    view.setBackgroundColor('#ffffff')
    view.setVisible(false)
    const wc = view.webContents
    wc.setWindowOpenHandler(({ url }) => {
      if (isWebUrl(url)) void wc.loadURL(url).catch(() => {})
      return { action: 'deny' }
    })
    const guard = (event: Electron.Event, url: string): void => {
      if (!isWebUrl(url)) event.preventDefault()
    }
    wc.on('will-navigate', guard)
    wc.on('will-redirect', guard)
    wc.on('did-start-navigation', (_e, _url, _inPage, isMainFrame) => {
      if (isMainFrame) this.error = null
    })
    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      // -3 is ERR_ABORTED: a navigation replaced by another one, not a failure.
      if (!isMainFrame || code === -3) return
      this.error = `${description || 'Load failed'} (${url})`
      this.changed()
    })
    wc.on('render-process-gone', (_e, details) => {
      this.error = `The page stopped (${details.reason}).`
      this.changed()
    })
    for (const event of [
      'did-start-loading',
      'did-stop-loading',
      'did-navigate',
      'did-navigate-in-page',
      'page-title-updated'
    ] as const) {
      wc.on(event as 'did-start-loading', () => this.changed())
    }
    window.contentView.addChildView(view)
    window.once('closed', () => {
      if (this.owner === window) {
        this.view = null
        this.owner = null
      }
    })
    this.view = view
    this.owner = window
    return view
  }

  private layout(): void {
    const view = this.view
    const window = this.owner
    if (!view || !window || window.isDestroyed() || view.webContents.isDestroyed()) return
    const show = this.bounds !== null && !this.error && view.webContents.getURL() !== ''
    if (show && this.bounds) {
      // The renderer measures in CSS pixels; the window lays out in DIPs.
      const zoom = window.webContents.getZoomFactor()
      const b: Rectangle = {
        x: Math.round(this.bounds.x * zoom),
        y: Math.round(this.bounds.y * zoom),
        width: Math.max(0, Math.round(this.bounds.width * zoom)),
        height: Math.max(0, Math.round(this.bounds.height * zoom))
      }
      view.setBounds(b)
    }
    view.setVisible(show)
  }

  setBounds(bounds: BrowserBounds | null): void {
    this.bounds = bounds
    this.layout()
  }

  async open(input: string): Promise<BrowserState> {
    const normalized = normalizeBrowserUrl(input)
    if ('error' in normalized) throw new Error(normalized.error)
    const view = this.ensure()
    this.error = null
    try {
      await view.webContents.loadURL(normalized.url)
    } catch (e) {
      // did-fail-load has recorded the reason; ERR_ABORTED (a redirect or a
      // newer navigation) isn't a failure.
      if (!this.error && !/ERR_ABORTED/.test(String(e))) this.error = String(e)
    }
    if (!view.webContents.isDestroyed()) await stoppedLoading(view.webContents, SETTLE_TIMEOUT_MS)
    this.changed()
    return this.state()
  }

  navigate(action: 'back' | 'forward' | 'reload' | 'stop'): BrowserState {
    const wc = this.view?.webContents
    if (wc && !wc.isDestroyed()) {
      if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
      else if (action === 'forward' && wc.navigationHistory.canGoForward())
        wc.navigationHistory.goForward()
      else if (action === 'reload') {
        this.error = null
        wc.reload()
      } else if (action === 'stop') wc.stop()
    }
    return this.state()
  }

  /** Reload and wait until the page has finished loading (or the wait runs out). */
  async reload(): Promise<BrowserState> {
    const wc = this.view?.webContents
    if (!wc || wc.isDestroyed() || !wc.getURL()) return this.state()
    this.error = null
    wc.reload()
    // reload() starts loading synchronously, so this waits for the new load.
    await stoppedLoading(wc, RELOAD_TIMEOUT_MS)
    return this.state()
  }

  private page(): Electron.WebContents {
    const wc = this.view?.webContents
    if (!wc || wc.isDestroyed() || !wc.getURL())
      throw new Error('No page is open in the browser panel.')
    if (this.error) throw new Error(`The page didn't load: ${this.error}`)
    return wc
  }

  private run(code: string, what: string): Promise<unknown> {
    const wc = this.page()
    return withTimeout(
      wc.executeJavaScriptInIsolatedWorld(PAGE_WORLD_ID, [{ code }]),
      SCRIPT_TIMEOUT_MS,
      what
    )
  }

  async inspect(): Promise<PageOutline> {
    return toOutline(await this.run(outlineScript(), 'Reading the page'))
  }

  async point(target: string, all: boolean): Promise<PageMatch[]> {
    return toMatches(await this.run(pointScript(target, all), 'Pointing at the page'))
  }

  async measure(targets: string[]): Promise<PageMatch[]> {
    return toMatches(await this.run(measureScript(targets), 'Measuring the page'))
  }

  /** Capture what the panel shows to <root>/.codeswim/browser/, keeping the newest few. */
  async screenshot(rootPath: string): Promise<PageScreenshot> {
    const wc = this.page()
    if (!this.view?.getVisible()) throw new Error('Open the browser panel to take a screenshot.')
    const image = await wc.capturePage()
    if (image.isEmpty()) throw new Error('The page has nothing to capture yet.')
    const dir = join(rootPath, ...SCREENSHOT_DIR.split('/'))
    await fs.mkdir(dir, { recursive: true })
    // Screenshots are scratch output, never project content.
    await fs.writeFile(join(dir, '.gitignore'), '*\n', { flag: 'wx' }).catch(() => {})
    const name = screenshotName(new Date())
    await fs.writeFile(join(dir, name), image.toPNG())
    const files = await fs.readdir(dir).catch(() => [] as string[])
    await Promise.all(screenshotsToPrune(files).map((f) => fs.rm(join(dir, f), { force: true })))
    const size = image.getSize()
    return { path: `${SCREENSHOT_DIR}/${name}`, width: size.width, height: size.height }
  }

  /**
   * What the panel shows, as a JPEG at most 1280 pixels wide: small enough to
   * keep several on the whiteboard (whiteboard-file.ts saves it there). A
   * tall view (the panel is often narrow) keeps only its top, at most 4:3,
   * so the picture is still readable at board size; `kept` is the share of
   * the view's height that's in it.
   */
  async capture(): Promise<{ jpeg: Buffer; width: number; height: number; kept: number }> {
    const wc = this.page()
    if (!this.view?.getVisible()) throw new Error('Open the browser panel to take a screenshot.')
    let image = await wc.capturePage()
    if (image.isEmpty()) throw new Error('The page has nothing to capture yet.')
    const full = image.getSize()
    const top = Math.min(full.height, Math.round(full.width * 0.75))
    if (top < full.height) image = image.crop({ x: 0, y: 0, width: full.width, height: top })
    if (image.getSize().width > 1280) image = image.resize({ width: 1280, quality: 'good' })
    const size = image.getSize()
    return {
      jpeg: image.toJPEG(80),
      width: size.width,
      height: size.height,
      kept: top / full.height
    }
  }

  private destroy(): void {
    const view = this.view
    const owner = this.owner
    this.view = null
    this.owner = null
    if (!view) return
    if (owner && !owner.isDestroyed()) owner.contentView.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  close(): void {
    this.destroy()
    this.error = null
    this.emit(this.state())
  }
}
