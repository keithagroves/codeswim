import { useCallback, useEffect, useRef } from 'react'
import { ActivityBar } from './components/ActivityBar'
import { Breadcrumbs } from './components/Breadcrumbs'
import { ChatPanel } from './components/ChatPanel'
import { DiagramView } from './components/DiagramView'
import { FileTree } from './components/FileTree'
import { GitPanel } from './components/GitPanel'
import { KanbanView } from './components/KanbanView'
import { ReadView } from './components/ReadView'
import { ScriptControls } from './components/ScriptControls'
import { ScriptOutput } from './components/ScriptOutput'
import { SearchPanel } from './components/SearchPanel'
import { SkillsPanel } from './components/SkillsPanel'
import { SkillsView } from './components/SkillsView'
import { TerminalPanel } from './components/TerminalPanel'
import { RoomChatPanel } from './components/RoomChatPanel'
import { Toasts } from './components/Toasts'
import { StoreProvider } from './state'
import { useStore } from './store'
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
      {state.activeSection === 'git' ? <GitPanel /> : null}
      {state.activeSection === 'terminal' ? <TerminalPanel /> : null}
      {state.activeSection === 'chat' ? <RoomChatPanel /> : null}
      <div
        className="side-panel-resizer"
        onMouseDown={onResizeStart}
        title="Drag to resize"
        aria-hidden="true"
      />
    </div>
  )
}

function Header(): React.JSX.Element {
  const { state, popTo, showOutput, navigateAbsolute, setWorkspaceView, openCurrentFileInEditor } =
    useStore()
  const inNavigator = state.workspaceView === 'navigator'
  const canGoBack = inNavigator && state.breadcrumbs.length > 0
  const running = state.runningScript
  const chip = running !== null && state.view !== 'output' ? running : null
  const atOverview = state.currentFile === 'overview.md'
  const rootName = state.rootPath?.split('/').filter(Boolean).at(-1) ?? 'Workspace'

  return (
    <div className="header">
      <div className="workspace-view-switch" role="tablist" aria-label="Workspace view">
        <button
          className={`tab-board ${state.workspaceView === 'kanban' ? 'is-active' : ''}`}
          role="tab"
          aria-selected={state.workspaceView === 'kanban'}
          onClick={() => setWorkspaceView('kanban')}
        >
          Board
        </button>
        <button
          className={`tab-diagram ${state.workspaceView === 'navigator' ? 'is-active' : ''}`}
          role="tab"
          aria-selected={state.workspaceView === 'navigator'}
          disabled={!state.currentFile}
          onClick={() => setWorkspaceView('navigator')}
        >
          Diagram
        </button>
      </div>
      {inNavigator ? (
        <>
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
        </>
      ) : (
        <div className="workspace-heading">{rootName}</div>
      )}
      <div className="header-actions">
        {inNavigator && state.currentFile ? (
          <button className="secondary" onClick={() => void openCurrentFileInEditor()}>
            Open in editor
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

  if (state.activeSection === 'skills') {
    return <SkillsView />
  }
  if (state.view === 'output') {
    return <ScriptOutput />
  }
  if (state.workspaceView === 'kanban') {
    return <KanbanView />
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
  return <ReadView source={state.fileContents} />
}

function StartScreen(): React.JSX.Element {
  const { state, pickRoot, newProject, openRecent, clearRecents } = useStore()
  const recents = state.recents

  return (
    <div className="start-screen">
      <img className="start-screen-logo" src={logoUrl} alt="codeswim" />
      <p>
        Pick a folder of markdown files with embedded mermaid diagrams. The agent in the side panel
        edits diagrams first, then code at the leaves.
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

// Ctrl+` toggles the terminal panel, as in VS Code. Uses e.code so it
// keys off the physical backquote key regardless of keyboard layout, and
// the capture phase so focused inputs can't swallow it.
function useTerminalShortcut(): void {
  const { toggleActiveSection } = useStore()
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === 'Backquote') {
        e.preventDefault()
        toggleActiveSection('terminal')
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [toggleActiveSection])
}

function Shell(): React.JSX.Element {
  const { state } = useStore()
  useTerminalShortcut()

  if (!state.rootPath) {
    // Skills view works without a workspace open — global + built-in skills
    // are still readable. Fall through to the regular layout in that case.
    if (state.activeSection !== 'skills') {
      return (
        <div className="app">
          <div className="main-row">
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
