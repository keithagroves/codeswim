import { describe, expect, it, vi } from 'vitest'
import type { BrowserState } from '@codeswim/contract'
import { BrowserPanel, type BrowserApi } from './panel'
import { detectDevUrls } from './dev-url'

const page = (over: Partial<BrowserState> = {}): BrowserState => ({
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  error: null,
  ...over
})

function fakeApi(): BrowserApi & { push(s: BrowserState): void } {
  let push: (s: BrowserState) => void = () => {}
  return {
    push: (s) => push(s),
    browserOpen: vi.fn(async (url: string) => page({ url })),
    browserNavigate: vi.fn(async () => page({ url: 'http://localhost:5173/' })),
    browserState: vi.fn(async () => page()),
    browserSetBounds: vi.fn(async () => {}),
    browserClose: vi.fn(async () => {}),
    browserInspect: vi.fn(async () => {
      throw new Error('unused')
    }),
    browserPoint: vi.fn(async (target: string) => [{ target, found: false }]),
    browserMeasure: vi.fn(async () => []),
    browserScreenshot: vi.fn(async () => ({
      path: '.codeswim/browser/s.png',
      width: 1,
      height: 1
    })),
    browserReload: vi.fn(async () => page()),
    onBrowserState: (cb) => {
      push = cb
      return () => {}
    }
  }
}

describe('BrowserPanel', () => {
  it('opening a URL opens the panel and follows state pushed from main', async () => {
    const api = fakeApi()
    const panel = new BrowserPanel(api)
    panel.start()
    await panel.open('localhost:5173')
    expect(panel.getSnapshot().open).toBe(true)
    expect(panel.currentUrl).toBe('localhost:5173')
    api.push(page({ url: 'http://localhost:5173/', title: 'Acme' }))
    expect(panel.getSnapshot().page.title).toBe('Acme')
  })

  it("throws main's reason when the page didn't load", async () => {
    const api = fakeApi()
    api.browserOpen = vi.fn(async () =>
      page({ url: 'http://localhost:1/', error: 'ERR_CONNECTION_REFUSED' })
    )
    const panel = new BrowserPanel(api)
    await expect(panel.open('localhost:1')).rejects.toThrow('ERR_CONNECTION_REFUSED')
    expect(panel.currentUrl).toBeNull()
  })

  it('hiding the panel hides the page view; a screenshot waits for it to be laid out again', async () => {
    const api = fakeApi()
    const panel = new BrowserPanel(api)
    panel.setOpen(true)
    panel.setOpen(false)
    expect(api.browserSetBounds).toHaveBeenLastCalledWith(null)
    const shot = panel.screenshot('/root')
    expect(panel.getSnapshot().open).toBe(true)
    expect(api.browserScreenshot).not.toHaveBeenCalled()
    panel.setBounds({ x: 900, y: 48, width: 500, height: 700 })
    await shot
    expect(api.browserScreenshot).toHaveBeenCalledWith('/root')
  })

  it('clamps and remembers the width', () => {
    const panel = new BrowserPanel(fakeApi())
    panel.setWidth(10)
    expect(panel.getSnapshot().width).toBe(320)
    panel.setWidth(99_999)
    expect(panel.getSnapshot().width).toBe(1400)
  })
})

describe('detectDevUrls', () => {
  it("finds the dev server's address in script output, newest first", () => {
    const out = [
      '\u001b[32m  VITE v5.0.0  ready in 300 ms\u001b[0m',
      '  ➜  Local:   \u001b[36mhttp://localhost:5173/\u001b[0m',
      '  ➜  Network: http://192.168.1.4:5173/',
      'restarted on http://0.0.0.0:3000.',
      'Local: http://localhost:5173/'
    ].join('\n')
    expect(detectDevUrls(out)).toEqual(['http://localhost:5173/', 'http://localhost:3000'])
    expect(detectDevUrls('no urls here')).toEqual([])
  })
})

describe('BrowserPanel.open', () => {
  it("reports a refused address without Electron's IPC wrapper", async () => {
    const api = fakeApi()
    api.browserOpen = vi.fn(async () => {
      throw new Error(
        "Error invoking remote method 'browser:open': Error: Only http and https pages open here."
      )
    })
    await expect(new BrowserPanel(api).open('file:///x')).rejects.toThrow(/^Only http and https/)
  })
})
