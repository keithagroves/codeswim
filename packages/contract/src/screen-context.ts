// Versioned snapshot of what the user is looking at, published to
// `.codeswim/agent-state.json` and read by the harness's `get_app_state`
// tool — a separate process, so this is a wire format, not a TS-only alias.
// Supersedes `AppStateSnapshot` (packages/contract/src/api.ts), which stays
// for one release so a snapshot written by an older build still parses (see
// formatAppState in packages/harness/src/tool/app-view.ts).

export interface NavigatorSurfaceContext {
  currentFile: string | null
  currentDocumentPath: string | null
  view: 'diagram' | 'read' | 'code' | 'output' | 'diff'
  breadcrumbs: string[]
  // Render errors for mermaid diagrams currently mounted in the open document.
  diagramErrors: string[]
}

export interface KanbanSurfaceContext {
  columns: Array<{ id: string; name: string; cardCount: number }>
  // Card whose editor/detail dialog is open, if any. null for both "nothing
  // open" and "editor open for an unsaved new card" (which has no id yet).
  openCardId: string | null
  // Cards with a Kanban "Run all" agent currently running in a worktree.
  runningCardIds: string[]
}

export interface WhiteboardSurfaceContext {
  // Topic pages on the whiteboard, in tab order; the current one by name.
  pages: string[]
  currentPage: string | null
  // 'building': a design the person agreed to is being built by the agent.
  mode: 'idle' | 'talking' | 'building' | 'walkthrough'
}

// The browser panel, while it's open (it sits beside every view, so it's
// never the focused surface). `error`: the page didn't load.
export interface BrowserSurfaceContext {
  url: string
  title: string
  loading: boolean
  error: string | null
}

export interface DiffSurfaceContext {
  path: string | null
  hunkCount: number
}

export interface TerminalSurfaceContext {
  tabCount: number
  activeTabId: string | null
  activeTabLabel: string | null
}

export interface ScriptOutputSurfaceContext {
  name: string
  status: 'running' | 'exited'
  // Bounded, ANSI-stripped tail — most recent lines only, see
  // apps/desktop/src/renderer/src/ansi.ts's stripAnsiToPlainLines/boundedTail.
  tail: string[]
}

export type FocusSurface =
  'navigator' | 'kanban' | 'agents' | 'whiteboard' | 'diff' | 'terminal' | 'script-output'

export interface ScreenContextV2 {
  version: 2
  workspaceView: 'navigator' | 'kanban' | 'agents' | 'whiteboard'
  focus: {
    surface: FocusSurface
    itemId: string | null
  }
  // Whether a script is running, regardless of which surface is focused —
  // its full (bounded) output only appears in surfaces.scriptOutput, and
  // only while script-output is the focused surface.
  runningScript: { name: string; status: 'running' | 'exited' } | null
  // Only populated for surfaces that are actually mounted/contributing right
  // now; terminal/scriptOutput are further limited to when they're the
  // focused surface, since their content can be large.
  surfaces: {
    navigator?: NavigatorSurfaceContext
    kanban?: KanbanSurfaceContext
    whiteboard?: WhiteboardSurfaceContext
    browser?: BrowserSurfaceContext
    diff?: DiffSurfaceContext
    terminal?: TerminalSurfaceContext
    scriptOutput?: ScriptOutputSurfaceContext
  }
}
