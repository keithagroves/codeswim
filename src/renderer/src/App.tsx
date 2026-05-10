import { useEffect, useRef, useState } from 'react'
import { Breadcrumbs } from './components/Breadcrumbs'
import { ChatPanel } from './components/ChatPanel'
import { CodeView } from './components/CodeView'
import { DiagramView } from './components/DiagramView'
import { FileTree } from './components/FileTree'
import { ScriptControls } from './components/ScriptControls'
import { ScriptOutput } from './components/ScriptOutput'
import { Toasts } from './components/Toasts'
import { extname } from './path-utils'
import { StoreProvider } from './state'
import { useStore } from './store'

function FileMenu(): React.JSX.Element {
  const { pickRoot } = useStore()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  return (
    <div className="menu" ref={ref}>
      <button
        className="secondary menu-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        File ▾
      </button>
      {open ? (
        <div className="menu-popover" role="menu">
          <button
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setOpen(false)
              void pickRoot()
            }}
          >
            Open folder…
          </button>
        </div>
      ) : null}
    </div>
  )
}

function Header(): React.JSX.Element {
  const { state, popTo, showOutput, toggleSidebar, toggleSource } = useStore()
  const canGoBack = state.breadcrumbs.length > 0
  const running = state.runningScript
  const chip = running !== null && state.view !== 'output' ? running : null
  const isMarkdown = state.currentFile !== null && extname(state.currentFile) === '.md'
  const showSourceToggle = isMarkdown && (state.view === 'diagram' || state.view === 'code')

  return (
    <div className="header">
      <FileMenu />
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
        {showSourceToggle ? (
          <button
            className="secondary"
            onClick={toggleSource}
            title={state.view === 'diagram' ? 'View raw markdown' : 'View rendered diagram'}
          >
            {state.view === 'diagram' ? '{ } Source' : '◉ Rendered'}
          </button>
        ) : null}
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
        <div className="header">
          <FileMenu />
        </div>
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
