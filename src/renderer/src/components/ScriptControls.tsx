import { useState } from 'react'
import { useStore } from '../store'

function entryKey(source: 'npm' | 'custom', name: string): string {
  return `${source}:${name}`
}

const CREATE_RUN_PROMPT =
  'Add a new entry to `.codeswim/runs.json` so I have a one-click way to run something from the toolbar. ' +
  'Ask me what the run should be called, what command to invoke, and (optionally) a short description, ' +
  'then create or update the file. Skip anything destructive.'

export function ScriptControls(): React.JSX.Element | null {
  const { state, runScript, killScript, showOutput, sendChat, setActiveSection } = useStore()
  const [selectedKey, setSelectedKey] = useState<string>('')

  if (!state.rootPath) return null

  const runs = state.runs
  const running = state.runningScript
  const isRunning = running?.status === 'running'

  const knownKeys = runs.map((r) => entryKey(r.source, r.name))
  const value = knownKeys.includes(selectedKey) ? selectedKey : knownKeys[0]
  const selectedEntry = runs.find((r) => entryKey(r.source, r.name) === value)

  const askAgentForNewRun = (): void => {
    setActiveSection('agent')
    void sendChat(CREATE_RUN_PROMPT)
  }

  return (
    <div className="script-controls">
      {runs.length > 0 ? (
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
      ) : null}
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
      ) : runs.length > 0 ? (
        <button
          className="script-btn script-run"
          onClick={() => selectedEntry && void runScript(selectedEntry)}
          title={selectedEntry?.command ?? ''}
          disabled={!selectedEntry}
        >
          ▶ Run
        </button>
      ) : null}
      <button
        className="script-btn script-add"
        onClick={askAgentForNewRun}
        title="Ask the agent to add a new run to .codeswim/runs.json"
        disabled={isRunning}
      >
        + Add run
      </button>
    </div>
  )
}
