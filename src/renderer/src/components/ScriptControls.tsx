import { useState } from 'react'
import { useStore } from '../store'

export function ScriptControls(): React.JSX.Element | null {
  const { state, runScript, killScript, showOutput } = useStore()
  const [selected, setSelected] = useState<string>('')

  if (state.scripts.length === 0) return null

  const running = state.runningScript
  const isRunning = running?.status === 'running'

  // Default the dropdown to the first script if nothing's selected yet.
  const value = selected || (state.scripts.includes(selected) ? selected : state.scripts[0])

  return (
    <div className="script-controls">
      <select
        className="script-select"
        value={value}
        onChange={(e) => setSelected(e.target.value)}
        disabled={isRunning}
        title="npm script to run"
      >
        {state.scripts.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      {isRunning ? (
        <>
          <button className="script-btn script-stop" onClick={() => void killScript()}>
            ■ Stop
          </button>
          {state.view !== 'output' ? (
            <button className="script-btn" onClick={showOutput}>
              Show output
            </button>
          ) : null}
        </>
      ) : (
        <button
          className="script-btn script-run"
          onClick={() => void runScript(value)}
          title={`npm run ${value}`}
        >
          ▶ Run
        </button>
      )}
    </div>
  )
}
