// The browser panel's state outside React: whether the panel is open, its
// width, and the page's state as main reports it (main/browser-host.ts owns
// the native page view; this owns the panel around it).
//
// One per StoreProvider, an external store like the whiteboard's controller,
// so the browser commands (commands/browser.ts), the whiteboard and the panel
// component all drive the same page.

import type {
  BrowserBounds,
  BrowserState,
  DiagramNavApi,
  PageMatch,
  PageOutline,
  PageScreenshot
} from '@codeswim/contract'

export type BrowserApi = Pick<
  DiagramNavApi,
  | 'browserOpen'
  | 'browserNavigate'
  | 'browserState'
  | 'browserSetBounds'
  | 'browserClose'
  | 'browserInspect'
  | 'browserPoint'
  | 'browserMeasure'
  | 'browserScreenshot'
  | 'browserReload'
  | 'onBrowserState'
>

export interface BrowserSnapshot {
  open: boolean
  width: number
  page: BrowserState
}

export const MIN_WIDTH = 320
export const MAX_WIDTH = 1400
const DEFAULT_WIDTH = 560
const WIDTH_KEY = 'codeswim:browserWidth'
// How long a caller that just opened the panel waits for it to be laid out
// (the page view only shows once it has bounds).
const LAYOUT_WAIT_MS = 2000

const EMPTY: BrowserState = {
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  error: null
}

function readWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY))
    if (Number.isFinite(n) && n >= MIN_WIDTH) return Math.min(MAX_WIDTH, n)
  } catch {
    // Blocked storage: the default is fine.
  }
  return DEFAULT_WIDTH
}

export class BrowserPanel {
  private snapshot: BrowserSnapshot
  private readonly listeners = new Set<() => void>()
  private started = false
  private laidOut = false
  private layoutWaiters: Array<() => void> = []

  constructor(private readonly api: BrowserApi) {
    this.snapshot = { open: false, width: readWidth(), page: EMPTY }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): BrowserSnapshot => this.snapshot

  private set(next: Partial<BrowserSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next }
    for (const l of this.listeners) l()
  }

  /** Follow the page's state from main. */
  start(): void {
    if (this.started) return
    this.started = true
    this.api.onBrowserState((page) => this.set({ page }))
    void this.api
      .browserState()
      .then((page) => this.set({ page }))
      .catch(() => {})
  }

  get isOpen(): boolean {
    return this.snapshot.open
  }

  /** The page showing in the panel right now, or null. */
  get currentUrl(): string | null {
    const { open, page } = this.snapshot
    return open && page.url && !page.error ? page.url : null
  }

  setOpen(open: boolean): void {
    if (open === this.snapshot.open) return
    if (!open) {
      this.laidOut = false
      void this.api.browserSetBounds(null).catch(() => {})
    }
    this.set({ open })
  }

  toggle(): void {
    this.setOpen(!this.snapshot.open)
  }

  setWidth(width: number): void {
    const w = Math.round(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width)))
    try {
      localStorage.setItem(WIDTH_KEY, String(w))
    } catch {
      // Not remembered; fine.
    }
    this.set({ width: w })
  }

  /** The panel's viewport moved or resized (null: it's gone). */
  setBounds(bounds: BrowserBounds | null): void {
    void this.api.browserSetBounds(bounds).catch(() => {})
    this.laidOut = bounds !== null && bounds.width > 0 && bounds.height > 0
    if (this.laidOut) {
      const waiters = this.layoutWaiters
      this.layoutWaiters = []
      for (const w of waiters) w()
    }
  }

  /** Open the panel (if needed) and wait until the page view has a place on screen. */
  async show(): Promise<void> {
    this.setOpen(true)
    if (this.laidOut) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, LAYOUT_WAIT_MS)
      this.layoutWaiters.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /** Open a URL in the panel. Throws with main's reason when the page didn't load. */
  async open(url: string): Promise<BrowserState> {
    this.setOpen(true)
    let page: BrowserState
    try {
      page = await this.api.browserOpen(url)
    } catch (e) {
      // A refused address; drop Electron's "Error invoking remote method" wrapper.
      const message = e instanceof Error ? e.message : String(e)
      throw new Error(message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
    this.set({ page })
    if (page.error) throw new Error(page.error)
    return page
  }

  async navigate(action: 'back' | 'forward' | 'reload' | 'stop'): Promise<BrowserState> {
    const page = await this.api.browserNavigate(action)
    this.set({ page })
    return page
  }

  /** Reload and wait for the page to finish loading. */
  async reload(): Promise<BrowserState> {
    const page = await this.api.browserReload()
    this.set({ page })
    return page
  }

  inspect(): Promise<PageOutline> {
    return this.api.browserInspect()
  }

  async point(target: string, all = false): Promise<PageMatch[]> {
    await this.show()
    return this.api.browserPoint(target, all)
  }

  measure(targets: string[]): Promise<PageMatch[]> {
    return this.api.browserMeasure(targets)
  }

  /** Capture what the panel shows; opens the panel first, since only a visible page can be captured. */
  async screenshot(root: string): Promise<PageScreenshot> {
    await this.show()
    return this.api.browserScreenshot(root)
  }

  /** Close the page itself (the panel's × only hides it). */
  async closePage(): Promise<void> {
    await this.api.browserClose()
    this.set({ page: EMPTY })
  }
}
