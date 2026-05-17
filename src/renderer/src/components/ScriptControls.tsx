import { useState } from 'react'
import { useStore } from '../store'

function entryKey(source: 'npm' | 'custom', name: string): string {
  return `${source}:${name}`
}

export function ScriptControls(): React.JSX.Element | null {
  const { state, runScript, killScript, showOutput } = useStore()
  const [selectedKey, setSelectedKey] = useState<string>('')

  const runs = state.runs
  if (runs.length === 0) return null

  const running = state.runningScript
  const isRunning = running?.status === 'running'

  const knownKeys = runs.map((r) => entryKey(r.source, r.name))
  const value = knownKeys.includes(selectedKey) ? selectedKey : knownKeys[0]
  const selectedEntry = runs.find((r) => entryKey(r.source, r.name) === value)

  return (
    <div className="script-controls">
      <select
        className="script-select"
        value={value}
        onChange={(e) => setSelectedKey(e.target.value)}
        disabled={isRunning}
        title={
          selectedEntry
            ? selectedEntry.source === 'npm'
              ? `npm run ${selectedEntry.name}`
              : selectedEntry.command
            : ''
        }
      >
        {runs.map((r) => (
          <option key={entryKey(r.source, r.name)} value={entryKey(r.source, r.name)}>
            {r.source === 'custom' ? `▸ ${r.name}` : r.name}
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
          onClick={() => selectedEntry && void runScript(selectedEntry)}
          title={selectedEntry?.command ?? ''}
          disabled={!selectedEntry}
        >
          ▶ Run
        </button>
      )}
    </div>
  )
}
