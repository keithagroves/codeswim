import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { ActivityBar } from './components/ActivityBar'
import { AgentsView } from './components/AgentsView'
import { Breadcrumbs } from './components/Breadcrumbs'
import { BrowserPanelView } from './components/BrowserPanelView'
import { ChatPanel } from './components/ChatPanel'
import { CodeView } from './components/CodeView'
import { DiagramView } from './components/DiagramView'
import { DiffView } from './components/DiffView'
import { FileTree } from './components/FileTree'
import { GitPanel } from './components/GitPanel'
import { HooksView } from './components/HooksView'
import { KanbanView } from './components/KanbanView'
import { PullRequestsPanel } from './components/PullRequestsPanel'
import { ReadView } from './components/ReadView'
import { ScriptControls } from './components/ScriptControls'
import { UpdateButton } from './components/UpdateButton'
import { CoveragePanel } from './components/CoveragePanel'
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

// The whiteboard pulls in tldraw, which is large; load it only when opened.
const WhiteboardView = lazy(() =>
  import('./components/WhiteboardView').then((m) => ({ default: m.WhiteboardView }))
)

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

  // Claude Code runs in a pty-backed panel, so it must survive section
  // switches and panel collapse. We mount it lazily on first open and then
  // keep it mounted, hiding it with display:none instead of unmounting.
  // (A conditional unmount would fire its cleanup and kill the session.)
  // The plain terminal lives in the bottom panel (TerminalDock).
  const claudeOpened = useRef(false)
  if (state.activeSection === 'claude') claudeOpened.current = true

  const collapsed = state.activeSection === null
  // When collapsed we keep the container in the tree (display:none) so a
  // background Claude Code session stays alive; an unmount would destroy it.
  if (collapsed && !claudeOpened.current) return null
  return (
    <div
      className="side-panel"
      style={{ width: state.sidePanelWidth, display: collapsed ? 'none' : 'flex' }}
    >
      {state.activeSection === 'files' ? <FileTree /> : null}
      {state.activeSection === 'agent' ? <ChatPanel /> : null}
      {state.activeSection === 'search' ? <SearchPanel /> : null}
      {state.activeSection === 'coverage' ? <CoveragePanel /> : null}
      {state.activeSection === 'tools' ? <SkillsPanel /> : null}
      {state.activeSection === 'git' ? <GitPanel /> : null}
      {state.activeSection === 'pulls' ? <PullRequestsPanel /> : null}
      {state.activeSection === 'chat' ? <RoomChatPanel /> : null}
      {claudeOpened.current ? (
        <div
          className="terminal-host"
          style={{ display: state.activeSection === 'claude' ? 'flex' : 'none' }}
        >
          <TerminalPanel command="claude" labelPrefix="Claude" surfaceId="claude" />
        </div>
      ) : null}
      <div
        className="side-panel-resizer"
        onMouseDown={onResizeStart}
        title="Drag to resize"
        aria-hidden="true"
      />
    </div>
  )
}

// The terminal panel along the bottom of the main column, like VS Code's:
// Ctrl+` or the Terminal icon toggles it, its top edge resizes it, and it can
// be maximized over the view. Its shells are live pty processes, so once
// opened it stays mounted and hides with display:none.
function TerminalDock(): React.JSX.Element | null {
  const { state, toggleTerminal, setTerminalHeight } = useStore()
  const open = state.terminalOpen
  const [everOpened, setEverOpened] = useState(open)
  const [maximized, setMaximized] = useState(false)
  const [prevOpen, setPrevOpen] = useState(open)
  const dockRef = useRef<HTMLDivElement>(null)

  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) setEverOpened(true)
    else setMaximized(false)
  }

  const onResizeStart = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault()
      const dock = dockRef.current
      if (!dock) return
      const startY = e.clientY
      const startHeight = dock.getBoundingClientRect().height
      const column = dock.parentElement?.getBoundingClientRect().height ?? window.innerHeight
      setMaximized(false)
      const onMove = (ev: MouseEvent): void => {
        setTerminalHeight(Math.min(column - 120, startHeight - (ev.clientY - startY)))
      }
      const onUp = (): void => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.body.classList.remove('is-resizing-rows')
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      document.body.classList.add('is-resizing-rows')
    },
    [setTerminalHeight]
  )

  if (!everOpened) return null
  return (
    <div
      ref={dockRef}
      className={`terminal-dock${maximized ? ' is-maximized' : ''}`}
      style={{
        display: open ? 'flex' : 'none',
        height: maximized ? undefined : state.terminalHeight
      }}
    >
      <div
        className="terminal-dock-resizer"
        onMouseDown={onResizeStart}
        onDoubleClick={() => setMaximized((m) => !m)}
        title="Drag to resize"
        aria-hidden="true"
      />
      <TerminalPanel
        // Opening it puts the cursor in the shell (not when restored at startup).
        focusSignal={state.terminalFocus}
        trailing={
          <>
            <button
              className="terminal-dock-btn"
              onClick={() => setMaximized((m) => !m)}
              title={maximized ? 'Restore panel size' : 'Maximize panel'}
              aria-label={maximized ? 'Restore panel size' : 'Maximize panel'}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path
                  d={maximized ? 'M2.5 4.5 6 8l3.5-3.5' : 'M2.5 7.5 6 4l3.5 3.5'}
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <button
              className="terminal-dock-btn"
              onClick={() => toggleTerminal(false)}
              title="Hide the terminal (Ctrl+`)"
              aria-label="Hide the terminal"
            >
              ×
            </button>
          </>
        }
      />
    </div>
  )
}

// A slim draggable strip standing in for the header on views that don't
// render one (start screen, skills). Keeps the whole top of the app a window
// drag handle — drag to move, double-click to zoom/maximize.
function DragStrip(): React.JSX.Element {
  return <div className="drag-strip" />
}

// The globe in the header: opens and closes the browser panel.
function BrowserToggle(): React.JSX.Element {
  const { browser } = useStore()
  const { open } = useSyncExternalStore(browser.subscribe, browser.getSnapshot)
  return (
    <button
      className="icon-btn browser-toggle"
      aria-pressed={open}
      title={open ? 'Hide the browser' : 'Show the browser'}
      aria-label={open ? 'Hide the browser' : 'Show the browser'}
      onClick={() => browser.toggle()}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.3" />
        <ellipse cx="8" cy="8" rx="2.6" ry="6.25" stroke="currentColor" strokeWidth="1.3" />
        <path d="M2 6h12M2 10h12" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    </button>
  )
}

function BrowserColumn(): React.JSX.Element | null {
  const { browser } = useStore()
  const { open } = useSyncExternalStore(browser.subscribe, browser.getSnapshot)
  return open ? <BrowserPanelView /> : null
}

function Header(): React.JSX.Element {
  const { state, showOutput, setWorkspaceView, openCurrentFileInEditor } = useStore()
  const inTools = state.activeSection === 'tools'
  const inNavigator = !inTools && state.workspaceView === 'navigator'
  const running = state.runningScript
  const chip = running !== null && state.view !== 'output' ? running : null
  const rootName = state.rootPath?.split('/').filter(Boolean).at(-1) ?? 'Workspace'

  return (
    <div className="header">
      <div className="workspace-view-switch" role="tablist" aria-label="Workspace view">
        <button
          className={`tab-diagram ${inNavigator ? 'is-active' : ''}`}
          role="tab"
          aria-selected={inNavigator}
          disabled={!state.currentFile}
          onClick={() => setWorkspaceView('navigator')}
        >
          Explore
        </button>
        <button
          className={`tab-board ${!inTools && state.workspaceView === 'kanban' ? 'is-active' : ''}`}
          role="tab"
          aria-selected={!inTools && state.workspaceView === 'kanban'}
          onClick={() => setWorkspaceView('kanban')}
        >
          Plan
        </button>
        <button
          className={`tab-agents ${!inTools && state.workspaceView === 'agents' ? 'is-active' : ''}`}
          role="tab"
          aria-selected={!inTools && state.workspaceView === 'agents'}
          onClick={() => setWorkspaceView('agents')}
        >
          Agents
        </button>
        <button
          className={`tab-whiteboard ${!inTools && state.workspaceView === 'whiteboard' ? 'is-active' : ''}`}
          role="tab"
          aria-selected={!inTools && state.workspaceView === 'whiteboard'}
          onClick={() => setWorkspaceView('whiteboard')}
        >
          Whiteboard
        </button>
      </div>
      {inTools || inNavigator ? (
        <div className="header-spacer" />
      ) : (
        <div className="workspace-heading">{rootName}</div>
      )}
      {inTools ? null : (
        <div className="header-actions">
          <UpdateButton />
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
          <BrowserToggle />
        </div>
      )}
    </div>
  )
}

// Browser-style Back / Forward / Home controls. These live in the path-bar
// (one row below the Explore/Plan tabs) rather than in the header itself.
function NavControls(): React.JSX.Element {
  const { state, goBack, goForward, navigateAbsolute } = useStore()
  const canGoBack = state.breadcrumbs.length > 0
  const canGoForward = state.forward.length > 0
  const atOverview = state.currentFile === 'overview.md'
  return (
    <div className="path-bar-nav">
      <button
        className="icon-btn"
        onClick={() => void goBack()}
        title="Back"
        aria-label="Back"
        disabled={!canGoBack}
      >
        ←
      </button>
      <button
        className="icon-btn"
        onClick={() => void goForward()}
        title="Forward"
        aria-label="Forward"
        disabled={!canGoForward}
      >
        →
      </button>
      <button
        className="icon-btn"
        onClick={() => void navigateAbsolute('overview.md', true)}
        title="Overview"
        aria-label="Overview"
        disabled={atOverview}
      >
        ⌂
      </button>
    </div>
  )
}

function Body(): React.JSX.Element {
  const { state } = useStore()

  if (state.activeSection === 'tools') {
    return state.toolsTab === 'hooks' ? <HooksView /> : <SkillsView />
  }
  if (state.view === 'output') {
    return <ScriptOutput />
  }
  // The diff viewer overrides the workspace surface — it's opened from the Sync
  // panel and should show regardless of whether Explore or Board is active.
  if (state.view === 'diff') {
    return <DiffView />
  }
  if (state.workspaceView === 'kanban') {
    return <KanbanView />
  }
  if (state.workspaceView === 'agents') {
    return <AgentsView />
  }
  if (state.workspaceView === 'whiteboard') {
    return (
      <Suspense fallback={<div className="empty-state">Loading the whiteboard…</div>}>
        <WhiteboardView />
      </Suspense>
    )
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
  if (state.view === 'code') {
    return (
      <CodeView
        path={state.currentFile ?? ''}
        contents={state.fileContents ?? ''}
        highlightRange={state.codeRange}
      />
    )
  }
  if (state.view === 'read') {
    return <ReadView source={state.fileContents} />
  }
  return <ReadView source={state.fileContents} />
}

function StartScreen(): React.JSX.Element {
  const { state, pickRoot, newProject, openDemo, openRecent, clearRecents } = useStore()
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
      <button className="link-btn start-screen-demo" onClick={() => void openDemo()}>
        Or try the demo project
      </button>

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
  const { toggleTerminal } = useStore()
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === 'Backquote') {
        e.preventDefault()
        toggleTerminal()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [toggleTerminal])
}

function Shell(): React.JSX.Element {
  const { state } = useStore()
  useTerminalShortcut()

  if (!state.rootPath) {
    // Tools view works without a workspace open — global + built-in skills
    // are still readable. Fall through to the regular layout in that case.
    if (state.activeSection !== 'tools') {
      return (
        <div className="app">
          <DragStrip />
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
            <DragStrip />
            <div className="content">
              <Body />
            </div>
            <TerminalDock />
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
          <Header />
          {state.activeSection !== 'tools' &&
          state.workspaceView === 'navigator' &&
          state.view !== 'output' &&
          state.view !== 'diff' &&
          state.currentFile ? (
            <div className="path-bar">
              <NavControls />
              <Breadcrumbs />
            </div>
          ) : null}
          <div className="content">
            <Body />
          </div>
          <TerminalDock />
        </div>
        <BrowserColumn />
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
