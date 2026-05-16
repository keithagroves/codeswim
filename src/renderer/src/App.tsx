import { Breadcrumbs } from './components/Breadcrumbs'
import { ChatPanel } from './components/ChatPanel'
import { CodeView } from './components/CodeView'
import { DiagramView } from './components/DiagramView'
import { FileTree } from './components/FileTree'
import { ReadView } from './components/ReadView'
import { ScriptControls } from './components/ScriptControls'
import { ScriptOutput } from './components/ScriptOutput'
import { Toasts } from './components/Toasts'
import { extname } from './path-utils'
import { StoreProvider } from './state'
import { useStore, type FileView } from './store'

function ViewSwitcher(): React.JSX.Element | null {
  const { state, setView } = useStore()
  if (!state.currentFile) return null
  if (extname(state.currentFile) !== '.md') return null
  if (state.view === 'output') return null

  const options: Array<{ key: FileView; label: string }> = [
    { key: 'read', label: 'Read' },
    { key: 'diagram', label: 'Diagram' },
    { key: 'code', label: 'Source' }
  ]

  return (
    <div className="view-switcher" role="group" aria-label="View mode">
      {options.map((opt) => (
        <button
          key={opt.key}
          className={`view-switcher-btn ${state.view === opt.key ? 'is-active' : ''}`}
          onClick={() => setView(opt.key)}
          aria-pressed={state.view === opt.key}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

function Header(): React.JSX.Element {
  const { state, popTo, showOutput, toggleSidebar } = useStore()
  const canGoBack = state.breadcrumbs.length > 0
  const running = state.runningScript
  const chip = running !== null && state.view !== 'output' ? running : null

  return (
    <div className="header">
      <button
        className="icon-btn"
        onClick={toggleSidebar}
        title={state.sidebarOpen ? 'Hide files' : 'Show files'}
        aria-pressed={state.sidebarOpen}
      >
        ☰
      </button>
      {canGoBack ? (
        <button
          className="secondary"
          onClick={() => void popTo(state.breadcrumbs.length - 1)}
          title="Back"
        >
          ← Back
        </button>
      ) : null}
      <Breadcrumbs />
      <div className="header-actions">
        <ViewSwitcher />
        {chip ? (
          <button
            className={`run-chip ${chip.status === 'running' ? 'is-running' : 'is-exited'}`}
            onClick={showOutput}
            title="Show script output"
          >
            <span className={`status-dot ${chip.status === 'running' ? 'running' : 'exited'}`} />
            {chip.name}
          </button>
        ) : null}
        <ScriptControls />
      </div>
    </div>
  )
}

function Body(): React.JSX.Element {
  const { state } = useStore()

  if (state.view === 'output') {
    return <ScriptOutput />
  }
  if (!state.currentFile || state.fileContents === null) {
    return (
      <div className="empty-state">
        {state.loading
          ? 'Loading…'
          : state.tree && state.tree.length > 0
            ? 'Pick a file from the sidebar.'
            : 'No file selected.'}
      </div>
    )
  }
  if (state.view === 'diagram') {
    return <DiagramView source={state.fileContents} />
  }
  if (state.view === 'read') {
    return <ReadView source={state.fileContents} />
  }
  return <CodeView path={state.currentFile} contents={state.fileContents} />
}

function StartScreen(): React.JSX.Element {
  const { pickRoot } = useStore()
  return (
    <div className="start-screen">
      <h1>codeswim</h1>
      <p>
        Pick a folder containing markdown files with embedded mermaid diagrams. The agent in the
        right panel will edit those diagrams first, then code at the leaves.
      </p>
      <p className="start-screen-hint">File → Open Folder… (⌘O)</p>
      <button className="primary" onClick={() => void pickRoot()}>
        Open folder…
      </button>
    </div>
  )
}

function Shell(): React.JSX.Element {
  const { state } = useStore()

  if (!state.rootPath) {
    return (
      <div className="app">
        <div className="main-row">
          <div className="content">
            <StartScreen />
          </div>
          <ChatPanel />
        </div>
        <Toasts />
      </div>
    )
  }

  return (
    <div className="app">
      <Header />
      <div className="main-row">
        <FileTree />
        <div className="content">
          <Body />
        </div>
        <ChatPanel />
      </div>
      <Toasts />
    </div>
  )
}

export default function App(): React.JSX.Element {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  )
}
