import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'

function entryKey(source: 'npm' | 'custom', name: string): string {
  return `${source}:${name}`
}

const CREATE_RUN_PROMPT =
  'Add a new entry to `.codeswim/runs.json` so I have a one-click way to run something from the toolbar. ' +
  'Ask me what the run should be called, what command to invoke, and (optionally) a short description, ' +
  'then create or update the file. Skip anything destructive.'

export function ScriptControls(): React.JSX.Element | null {
  const { state, runScript, killScript, sendChat, setActiveSection } = useStore()
  const [selectedKey, setSelectedKey] = useState<string>('')
  const [menuOpen, setMenuOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  if (!state.rootPath) return null

  const runs = state.runs
  const running = state.runningScript
  const isRunning = running?.status === 'running'

  const knownKeys = runs.map((r) => entryKey(r.source, r.name))
  const value = knownKeys.includes(selectedKey) ? selectedKey : knownKeys[0]
  const selectedEntry = runs.find((r) => entryKey(r.source, r.name) === value)

  const commandOf = (r: (typeof runs)[number]): string =>
    r.source === 'npm' ? `npm run ${r.name}` : r.command

  const askAgentForNewRun = (): void => {
    setMenuOpen(false)
    setActiveSection('agent')
    void sendChat(CREATE_RUN_PROMPT)
  }

  // No runs yet — offer to set one up via the agent. Once runs exist the
  // same action lives at the bottom of the dropdown menu.
  if (runs.length === 0) {
    return (
      <div className="run-control">
        <button
          className="run-control-main run-control-add"
          onClick={askAgentForNewRun}
          title="Ask the agent to add a run to .codeswim/runs.json"
        >
          + Add run
        </button>
      </div>
    )
  }

  return (
    <div className="run-control" ref={wrapRef}>
      {isRunning ? (
        <button
          className="run-control-main is-stop"
          onClick={() => void killScript()}
          title={`Stop ${running?.name ?? ''}`}
        >
          <span className="run-glyph">■</span>
          Stop
        </button>
      ) : (
        <button
          className="run-control-main is-run"
          onClick={() => selectedEntry && void runScript(selectedEntry)}
          title={selectedEntry ? commandOf(selectedEntry) : ''}
          disabled={!selectedEntry}
        >
          <span className="run-glyph">▶</span>
          {selectedEntry?.name ?? 'Run'}
        </button>
      )}
      <button
        className="run-control-caret"
        onClick={() => setMenuOpen((v) => !v)}
        disabled={isRunning}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title="Choose a run"
      >
        ▾
      </button>
      {menuOpen ? (
        <div className="run-menu" role="menu">
          {runs.map((r) => {
            const key = entryKey(r.source, r.name)
            return (
              <button
                key={key}
                role="menuitem"
                className={`run-menu-item ${key === value ? 'is-selected' : ''}`}
                onClick={() => {
                  setSelectedKey(key)
                  setMenuOpen(false)
                  void runScript(r)
                }}
              >
                <span className="run-menu-name">{r.name}</span>
                <span className="run-menu-cmd">{r.description ?? commandOf(r)}</span>
              </button>
            )
          })}
          <div className="run-menu-divider" />
          <button
            className="run-menu-item run-menu-add"
            role="menuitem"
            onClick={askAgentForNewRun}
          >
            + Add run…
          </button>
        </div>
      ) : null}
    </div>
  )
}
