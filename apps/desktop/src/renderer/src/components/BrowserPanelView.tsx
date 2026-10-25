// The browser panel: a right-side column with an address bar over a live
// page. The page itself is a native view main lays over `.browser-viewport`
// (main/browser-host.ts) — this component only measures where that is. DOM
// can't draw on top of the native view, so anything the panel needs to say
// (loading errors, the empty state) shows while the view is hidden.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { BrowserSurfaceContext } from '@codeswim/contract'
import { useStore } from '../store'
import { useSurfaceContext } from '../context/useSurfaceContext'
import { detectDevUrls } from '../browser/dev-url'
import { MAX_WIDTH, MIN_WIDTH } from '../browser/panel'

export function BrowserPanelView(): React.JSX.Element {
  const { state, browser } = useStore()
  const snap = useSyncExternalStore(browser.subscribe, browser.getSnapshot)
  const { page } = snap
  const viewportRef = useRef<HTMLDivElement>(null)
  const [address, setAddress] = useState(page.url)
  const [editing, setEditing] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)

  // The address bar follows the page unless the person is typing in it.
  const shownAddress = editing ? address : page.url

  const block = useMemo(
    (): BrowserSurfaceContext => ({
      url: page.url,
      title: page.title,
      loading: page.loading,
      error: page.error
    }),
    [page.url, page.title, page.loading, page.error]
  )
  useSurfaceContext('browser', block)

  // Keep the native page view over the viewport. Position changes without a
  // size change (the window resizing) don't fire ResizeObserver, so the
  // window's resize event is watched too.
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    let frame = 0
    const send = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect()
        browser.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height })
      })
    }
    send()
    const ro = new ResizeObserver(send)
    ro.observe(el)
    window.addEventListener('resize', send)
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
      window.removeEventListener('resize', send)
      browser.setBounds(null)
    }
  }, [browser])

  const open = useCallback(
    async (url: string) => {
      setOpenError(null)
      setEditing(false)
      try {
        await browser.open(url)
      } catch (e) {
        // Load failures show from page.error; this is for a refused address.
        const message = e instanceof Error ? e.message : String(e)
        if (message !== browser.getSnapshot().page.error) setOpenError(message)
      }
    },
    [browser]
  )

  const onResizeStart = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = browser.getSnapshot().width
      const onMove = (ev: MouseEvent): void => {
        browser.setWidth(startWidth - (ev.clientX - startX))
      }
      const onUp = (): void => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.body.classList.remove('is-resizing')
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      document.body.classList.add('is-resizing')
    },
    [browser]
  )

  const devUrls = state.runningScript ? detectDevUrls(state.runningScript.output) : []
  const showPage = !!page.url && !page.error

  return (
    <aside
      className="browser-panel"
      style={{ width: snap.width, minWidth: MIN_WIDTH, maxWidth: MAX_WIDTH }}
      aria-label="Browser"
    >
      <div className="browser-resizer" onMouseDown={onResizeStart} aria-hidden="true" />
      <form
        className="browser-bar"
        onSubmit={(e) => {
          e.preventDefault()
          // Like a browser: focus goes to the page, and the bar follows it again.
          ;(document.activeElement as HTMLElement | null)?.blur()
          void open(shownAddress)
        }}
      >
        <button
          type="button"
          className="icon-btn"
          title="Back"
          aria-label="Back"
          disabled={!page.canGoBack}
          onClick={() => void browser.navigate('back')}
        >
          ←
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Forward"
          aria-label="Forward"
          disabled={!page.canGoForward}
          onClick={() => void browser.navigate('forward')}
        >
          →
        </button>
        <button
          type="button"
          className="icon-btn"
          title={page.loading ? 'Stop' : 'Reload'}
          aria-label={page.loading ? 'Stop' : 'Reload'}
          disabled={!page.url}
          onClick={() => void browser.navigate(page.loading ? 'stop' : 'reload')}
        >
          {page.loading ? '✕' : '↻'}
        </button>
        <input
          className="browser-address"
          value={shownAddress}
          placeholder="localhost:5173"
          spellCheck={false}
          aria-label="Address"
          onFocus={(e) => {
            setAddress(page.url)
            setEditing(true)
            e.currentTarget.select()
          }}
          onBlur={() => setEditing(false)}
          onChange={(e) => {
            setAddress(e.target.value)
            setEditing(true)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setEditing(false)
              e.currentTarget.blur()
            }
          }}
        />
        <button
          type="button"
          className="icon-btn"
          title="Close the browser panel"
          aria-label="Close the browser panel"
          onClick={() => browser.setOpen(false)}
        >
          ×
        </button>
      </form>
      {page.loading ? <div className="browser-progress" aria-hidden="true" /> : null}
      <div className="browser-viewport" ref={viewportRef}>
        {showPage ? null : (
          <div className="browser-empty">
            {openError ? <p className="browser-error">{openError}</p> : null}
            {page.error ? (
              <>
                <p className="browser-error">This page didn&apos;t load.</p>
                <p className="browser-error-detail">{page.error}</p>
                <button className="secondary" onClick={() => void browser.navigate('reload')}>
                  Try again
                </button>
              </>
            ) : (
              <>
                <p>Open a page to look at it next to your work: your dev server, or any site.</p>
                {devUrls.length ? (
                  <div className="browser-suggestions">
                    {devUrls.map((url) => (
                      <button key={url} className="secondary" onClick={() => void open(url)}>
                        Open {url}
                        {state.runningScript ? (
                          <span className="browser-suggestion-from">
                            {' '}
                            from npm run {state.runningScript.name}
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="browser-hint">
                    Start your dev server with Run in the header, and its address shows up here.
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}
