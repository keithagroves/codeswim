import type {
  BrowserSurfaceContext,
  DiffSurfaceContext,
  FocusSurface,
  KanbanSurfaceContext,
  ScreenContextV2,
  ScriptOutputSurfaceContext,
  TerminalSurfaceContext,
  WhiteboardSurfaceContext
} from '@codeswim/contract'
import type { AppState } from '../store'
import { boundedTail, stripAnsiToPlainLines } from '../ansi'

// Most recent lines of a running script's output to publish — enough to be
// useful context, small enough not to bloat the published file on a chatty
// dev server.
const SCRIPT_OUTPUT_MAX_LINES = 40
const SCRIPT_OUTPUT_MAX_BYTES = 4000

function diagramErrorsFrom(blocks: Record<string, unknown>): string[] {
  const errors: string[] = []
  for (const [name, block] of Object.entries(blocks)) {
    if (!name.startsWith('navigator:diagram:')) continue
    const error = (block as { error?: unknown } | null)?.error
    if (typeof error === 'string') errors.push(error)
  }
  return errors
}

function countHunks(diffContent: string | null): number {
  if (!diffContent) return 0
  return (diffContent.match(/^@@ /gm) ?? []).length
}

// diff/output are transient main-panel overlays a user action just opened,
// so they win over whatever the side panel or workspaceView currently show.
// The side-panel terminal is next: it takes a deliberate tab click. Anything
// else falls back to the main workspaceView.
function deriveFocus(
  state: AppState,
  blocks: Record<string, unknown>
): { surface: FocusSurface; itemId: string | null } {
  if (state.view === 'diff') return { surface: 'diff', itemId: state.diffPath }
  if (state.view === 'output') {
    return { surface: 'script-output', itemId: state.runningScript?.name ?? null }
  }
  if (state.activeSection === 'claude') {
    const terminal = blocks['terminal:claude'] as TerminalSurfaceContext | undefined
    return { surface: 'terminal', itemId: terminal?.activeTabId ?? null }
  }
  if (state.workspaceView === 'kanban') {
    const kanban = blocks.kanban as KanbanSurfaceContext | undefined
    return { surface: 'kanban', itemId: kanban?.openCardId ?? null }
  }
  if (state.workspaceView === 'agents') {
    return { surface: 'agents', itemId: state.activeAgentTabId }
  }
  if (state.workspaceView === 'whiteboard') {
    const whiteboard = blocks.whiteboard as WhiteboardSurfaceContext | undefined
    return { surface: 'whiteboard', itemId: whiteboard?.currentPage ?? null }
  }
  return { surface: 'navigator', itemId: state.currentFile }
}

// Pure composition of the reducer's state plus whatever surface blocks are
// currently registered — no React, so it's directly unit-testable. Called
// from the debounced publish effect in state.tsx on every state or
// surface-context change.
export function composeScreenContext(
  state: AppState,
  blocks: Record<string, unknown>
): ScreenContextV2 {
  const focus = deriveFocus(state, blocks)
  const surfaces: ScreenContextV2['surfaces'] = {}

  if (state.workspaceView === 'navigator') {
    surfaces.navigator = {
      currentFile: state.currentFile,
      currentDocumentPath: state.currentDocumentPath,
      view: state.view,
      breadcrumbs: state.breadcrumbs,
      diagramErrors: diagramErrorsFrom(blocks)
    }
  }

  const kanban = blocks.kanban as KanbanSurfaceContext | undefined
  if (kanban) surfaces.kanban = kanban

  const whiteboard = blocks.whiteboard as WhiteboardSurfaceContext | undefined
  if (state.workspaceView === 'whiteboard' && whiteboard) surfaces.whiteboard = whiteboard

  // The browser panel sits beside whatever view is showing.
  const browser = blocks.browser as BrowserSurfaceContext | undefined
  if (browser) surfaces.browser = browser

  if (state.view === 'diff') {
    const diff: DiffSurfaceContext = { path: state.diffPath, hunkCount: countHunks(state.diffContent) }
    surfaces.diff = diff
  }

  // Terminal/script-output content is bounded but still nontrivial — only
  // publish it while it's actually the focused surface.
  // The bottom terminal panel sits under whatever view is showing, so it's
  // published while open without taking focus (its block is small).
  if (focus.surface === 'terminal') {
    const terminal = blocks['terminal:claude'] as TerminalSurfaceContext | undefined
    if (terminal) surfaces.terminal = terminal
  } else if (state.terminalOpen) {
    const terminal = blocks['terminal:terminal'] as TerminalSurfaceContext | undefined
    if (terminal) surfaces.terminal = terminal
  }

  if (focus.surface === 'script-output' && state.runningScript) {
    const plainLines = stripAnsiToPlainLines(state.runningScript.output)
    const scriptOutput: ScriptOutputSurfaceContext = {
      name: state.runningScript.name,
      status: state.runningScript.status,
      tail: boundedTail(plainLines, SCRIPT_OUTPUT_MAX_LINES, SCRIPT_OUTPUT_MAX_BYTES)
    }
    surfaces.scriptOutput = scriptOutput
  }

  const runningScript = state.runningScript
    ? { name: state.runningScript.name, status: state.runningScript.status }
    : null

  return { version: 2, workspaceView: state.workspaceView, focus, runningScript, surfaces }
}
