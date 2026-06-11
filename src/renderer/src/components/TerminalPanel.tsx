import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { FitAddon, Ghostty, Terminal } from 'ghostty-web'
// Vite resolves this to the actual URL of the WASM file (hashed in prod, @fs path in dev).
// This bypasses ghostty's fallback chain that tries to fetch /ghostty-vt.wasm from the SPA root.
// @ts-ignore — .wasm?url is a Vite-specific import form; no TS declaration needed
import ghosttyWasmUrl from 'ghostty-web/ghostty-vt.wasm?url'
import { useStore } from '../store'

// Load Ghostty WASM once for the app lifetime — reuse across all terminal instances.
let ghosttyCache: Promise<{ ghostty: Ghostty; Terminal: typeof Terminal; FitAddon: typeof FitAddon }> | null = null
function loadGhostty() {
  if (!ghosttyCache) {
    ghosttyCache = import('ghostty-web')
      .then(async (mod) => {
        const ghostty = await mod.Ghostty.load(ghosttyWasmUrl as string)
        return { ghostty, Terminal: mod.Terminal as typeof Terminal, FitAddon: mod.FitAddon as typeof FitAddon }
      })
      .catch((err) => {
        ghosttyCache = null
        throw err
      })
  }
  return ghosttyCache
}

let tabCounter = 0
function nextTabId(): string {
  return String(++tabCounter)
}

interface TabInfo {
  id: string
  label: string
}

function TerminalInstance({ cwd, active }: { cwd: string | null; active: boolean }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const prevActiveRef = useRef(active)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Re-fit after becoming visible — canvas can't measure while hidden.
  useEffect(() => {
    if (active && !prevActiveRef.current && fitRef.current) {
      requestAnimationFrame(() => fitRef.current?.fit())
    }
    prevActiveRef.current = active
  }, [active])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    let destroyed = false
    let term: Terminal | null = null
    let fitAddon: FitAddon | null = null
    let terminalId: string | null = null
    let offData: (() => void) | null = null
    let offExit: (() => void) | null = null
    let observer: ResizeObserver | null = null
    let sizeTimer: ReturnType<typeof setTimeout> | undefined

    loadGhostty()
      .then(({ ghostty, Terminal: Term, FitAddon: Fit }) => {
        if (destroyed) return

        term = new Term({
          ghostty,
          cursorBlink: true,
          cursorStyle: 'bar',
          fontSize: 13,
          fontFamily: 'Menlo, Monaco, "Courier New", monospace',
          scrollback: 10000,
          allowTransparency: false,
          theme: {
            background: '#0e0e11',
            foreground: '#d4d4d4',
            cursor: '#d4d4d4',
            selectionBackground: '#264f78',
          },
        })

        fitAddon = new Fit()
        term.loadAddon(fitAddon)
        term.open(el)
        fitAddon.fit()
        fitRef.current = fitAddon

        const scheduleResize = (): void => {
          fitAddon?.fit()
          if (sizeTimer !== undefined) clearTimeout(sizeTimer)
          sizeTimer = setTimeout(() => {
            if (terminalId && term) {
              window.api.terminalResize(terminalId, term.cols, term.rows)
            }
          }, 100)
        }

        observer = new ResizeObserver(scheduleResize)
        observer.observe(el)

        void window.api.terminalCreate(cwd ?? undefined).then((id) => {
          if (destroyed) {
            window.api.terminalDestroy(id)
            return
          }
          terminalId = id
          term!.onData((data) => window.api.terminalWrite(id, data))
          offData = window.api.onTerminalData((incomingId, data) => {
            if (incomingId === id) term!.write(data)
          })
          offExit = window.api.onTerminalExit((incomingId) => {
            if (incomingId === id) term!.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n')
          })
        })
      })
      .catch((err: unknown) => {
        if (destroyed) return
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[terminal] failed to load ghostty-web:', err)
        setLoadError(msg)
      })

    return () => {
      destroyed = true
      if (sizeTimer !== undefined) clearTimeout(sizeTimer)
      observer?.disconnect()
      offData?.()
      offExit?.()
      if (terminalId) window.api.terminalDestroy(terminalId)
      term?.dispose()
      fitRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (loadError) {
    return (
      <div
        className="terminal-instance"
        style={{
          display: active ? 'flex' : 'none',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#f44747',
          fontSize: 12,
          padding: 12,
        }}
      >
        Terminal error: {loadError}
      </div>
    )
  }

  return <div ref={containerRef} className="terminal-instance" style={{ display: active ? 'block' : 'none' }} />
}

export function TerminalPanel(): React.JSX.Element {
  const { state } = useStore()
  const cwdRef = useRef(state.rootPath)

  useEffect(() => {
    cwdRef.current = state.rootPath
  }, [state.rootPath])

  const [tabs, setTabs] = useState<TabInfo[]>(() => [{ id: nextTabId(), label: 'Terminal 1' }])
  const [activeTab, setActiveTab] = useState<string>(() => tabs[0].id)

  const addTab = useCallback(() => {
    const id = nextTabId()
    const label = `Terminal ${tabCounter}`
    setTabs((prev) => [...prev, { id, label }])
    setActiveTab(id)
  }, [])

  const closeTab = useCallback(
    (tabId: string) => {
      if (tabs.length <= 1) return
      const idx = tabs.findIndex((t) => t.id === tabId)
      const next = tabs[idx + 1] ?? tabs[idx - 1]
      setTabs((prev) => prev.filter((t) => t.id !== tabId))
      if (activeTab === tabId && next) setActiveTab(next.id)
    },
    [tabs, activeTab],
  )

  return (
    <div className="terminal-panel-outer">
      <div className="terminal-tab-bar">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`terminal-tab${activeTab === tab.id ? ' active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span className="terminal-tab-label">{tab.label}</span>
            {tabs.length > 1 && (
              <button
                className="terminal-tab-close"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(tab.id)
                }}
                aria-label="Close terminal"
              >
                ×
              </button>
            )}
          </div>
        ))}
        <button className="terminal-add-btn" onClick={addTab} title="New terminal" aria-label="New terminal">
          +
        </button>
      </div>
      <div className="terminal-instances">
        {tabs.map((tab) => (
          <TerminalInstance key={tab.id} cwd={cwdRef.current} active={tab.id === activeTab} />
        ))}
      </div>
    </div>
  )
}
