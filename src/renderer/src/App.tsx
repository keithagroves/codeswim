import { useCallback, useEffect, useRef } from 'react'
import { ActivityBar } from './components/ActivityBar'
import { Breadcrumbs } from './components/Breadcrumbs'
import { ChatPanel } from './components/ChatPanel'
import { CodeView } from './components/CodeView'
import { DiagramView } from './components/DiagramView'
import { FileTree } from './components/FileTree'
import { ReadView } from './components/ReadView'
import { ScriptControls } from './components/ScriptControls'
import { ScriptOutput } from './components/ScriptOutput'
import { SearchPanel } from './components/SearchPanel'
import { SkillsPanel } from './components/SkillsPanel'
import { SkillsView } from './components/SkillsView'
import { Toasts } from './components/Toasts'
import { extname } from './path-utils'
import { StoreProvider } from './state'
import { useStore, type FileView } from './store'
import logoUrl from './assets/codeswim.svg'

function SidePanel(): React.JSX.Element | null {
  const { state, setSidePanelWidth } = useStore()
  const widthRef = useRef(state.sidePanelWidth)

  const onResizeStart = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = widthRef.current
      const onMove = (ev: MouseEvent): void => {
        const next = Math.max(180, Math.min(700, startWidth + (ev.clientX - startX)))
        widthRef.current = next
        // Update directly via dispatch for live drag; the throttle is fine
        // for occasional pixel updates in a single panel.
        setSidePanelWidth(next)
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
    [setSidePanelWidth]
  )

  // Keep the ref in sync with state so a fresh drag starts from the
  // current width (e.g. after window resize or programmatic change).
  useEffect(() => {
    widthRef.current = state.sidePanelWidth
  }, [state.sidePanelWidth])

  if (state.activeSection === null) return null
  return (
    <div className="side-panel" style={{ width: state.sidePanelWidth }}>
      {state.activeSection === 'files' ? <FileTree /> : null}
      {state.activeSection === 'agent' ? <ChatPanel /> : null}
      {state.activeSection === 'search' ? <SearchPanel /> : null}
      {state.activeSection === 'skills' ? <SkillsPanel /> : null}
      <div
        className="side-panel-resizer"
        onMouseDown={onResizeStart}
        title="Drag to resize"
        aria-hidden="true"
      />
    </div>
  )
}

function ViewSwitcher(): React.JSX.Element | null {
  const { state, setView } = useStore()
  if (!state.currentFile) return null
  if (extname(state.currentFile) !== '.md') return null
  if (state.view === 'output') return null

  // Read view exists in code but is hidden from the switcher for now —
  // re-enable by re-adding `{ key: 'read', label: 'Read' }` here.
  const options: Array<{ key: FileView; label: string }> = [
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
  const { state, popTo, showOutput, navigateAbsolute, syncDiagrams } = useStore()
  const canGoBack = state.breadcrumbs.length > 0
  const running = state.runningScript
  const chip = running !== null && state.view !== 'output' ? running : null
  const atOverview = state.currentFile === 'overview.md'

  return (
    <div className="header">
      {canGoBack ? (
        <button
          className="icon-btn"
          onClick={() => void popTo(state.breadcrumbs.length - 1)}
          title="Back"
          aria-label="Back"
        >
          ←
        </button>
      ) : null}
      <button
        className="icon-btn"
        onClick={() => void navigateAbsolute('overview.md', true)}
        title="Overview"
        aria-label="Overview"
        disabled={atOverview}
      >
        ⌂
      </button>
      <Breadcrumbs />
      <div className="header-actions">
        <button
          className="secondary"
          onClick={() => void syncDiagrams()}
          title="Audit diagrams against the code and ask the agent to fix any drift"
        >
          ↻ Sync diagrams
        </button>
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

  if (state.activeSection === 'skills') {
    return <SkillsView />
  }
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
  return (
    <CodeView
      path={state.currentFile}
      contents={state.fileContents}
      highlightRange={state.currentRange}
    />
  )
}

function StartScreen(): React.JSX.Element {
  const { state, pickRoot, newProject, openRecent, clearRecents } = useStore()
  const recents = state.recents

  return (
    <div className="start-screen">
      <img className="start-screen-logo" src={logoUrl} alt="codeswim" />
      <p>
        Pick a folder of markdown files with embedded mermaid diagrams. The agent in the side
        panel edits diagrams first, then code at the leaves.
      </p>
      <div className="start-screen-actions">
        <button className="primary" onClick={() => void newProject()}>
          + New project…
        </button>
        <button className="secondary" onClick={() => void pickRoot()}>
          Open folder…
        </button>
      </div>
      <p className="start-screen-hint">⌘N to create · ⌘O to open</p>

      {recents.length > 0 ? (
        <div className="start-recents">
          <div className="start-recents-header">
            <span>Recent</span>
            <button className="link-btn" onClick={() => void clearRecents()}>
              Clear
            </button>
          </div>
          <ul className="start-recents-list">
            {recents.map((path) => {
              const segs = path.split('/').filter(Boolean)
              const name = segs[segs.length - 1] ?? path
              const parent = segs.slice(0, -1).join('/')
              return (
                <li key={path}>
                  <button
                    className="start-recent-item"
                    onClick={() => void openRecent(path)}
                    title={path}
                  >
                    <span className="start-recent-name">{name}</span>
                    <span className="start-recent-path">{parent || '/'}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

function Shell(): React.JSX.Element {
  const { state } = useStore()

  if (!state.rootPath) {
    // Skills view works without a workspace open — global + built-in skills
    // are still readable. Fall through to the regular layout in that case.
    if (state.activeSection !== 'skills') {
      return (
        <div className="app">
          <div className="main-row">
            <ActivityBar />
            <SidePanel />
            <div className="content">
              <StartScreen />
            </div>
          </div>
          <Toasts />
        </div>
      )
    }
    return (
      <div className="app">
        <div className="main-row">
          <ActivityBar />
          <SidePanel />
          <div className="main-column">
            <div className="content">
              <Body />
            </div>
          </div>
        </div>
        <Toasts />
      </div>
    )
  }

  return (
    <div className="app">
      <div className="main-row">
        <ActivityBar />
        <SidePanel />
        <div className="main-column">
          {state.activeSection === 'skills' ? null : <Header />}
          <div className="content">
            <Body />
          </div>
        </div>
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
