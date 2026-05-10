import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'

export function ScriptOutput(): React.JSX.Element {
  const { state, runScript, killScript, hideOutput } = useStore()
  const running = state.runningScript
  const preRef = useRef<HTMLPreElement>(null)
  const stickRef = useRef(true)
  // `now` is state (not a render-time Date.now() call) so elapsed time is
  // a pure derivation and React's purity rules are satisfied.
  const [now, setNow] = useState(() => Date.now())

  // Tick once a second while running so elapsed time updates even when
  // the process is silent.
  useEffect(() => {
    if (running?.status !== 'running') return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [running?.status])

  // Track whether the user has scrolled away from the bottom — if so,
  // stop auto-following so we don't yank them back on each new chunk.
  useEffect(() => {
    const el = preRef.current
    if (!el) return
    const onScroll = (): void => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      stickRef.current = distance < 8
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // Auto-scroll on new output if the user is following the tail.
  useEffect(() => {
    const el = preRef.current
    if (!el || !stickRef.current) return
    el.scrollTop = el.scrollHeight
  }, [running?.output])

  if (!running) {
    return (
      <div className="empty-state">
        <p>No script has been run yet.</p>
      </div>
    )
  }

  const isRunning = running.status === 'running'
  const elapsed = Math.floor((now - running.startedAt) / 1000)

  return (
    <div className="script-output">
      <div className="script-output-header">
        <div className="script-output-title">
          <span className={`status-dot ${isRunning ? 'running' : 'exited'}`} />
          <span className="script-output-name">npm run {running.name}</span>
          <span className="script-output-meta">
            {isRunning
              ? `running · ${elapsed}s`
              : running.signal
                ? `killed (${running.signal})`
                : `exited (code ${running.exitCode ?? '?'})`}
          </span>
        </div>
        <div className="script-output-actions">
          {isRunning ? (
            <button className="secondary" onClick={() => void killScript()}>
              Stop
            </button>
          ) : (
            <button className="secondary" onClick={() => void runScript(running.name)}>
              Run again
            </button>
          )}
          <button className="secondary" onClick={hideOutput}>
            Hide
          </button>
        </div>
      </div>
      <pre className="script-output-body" ref={preRef}>
        {running.output || (isRunning ? 'Waiting for output…' : '(no output)')}
      </pre>
    </div>
  )
}
