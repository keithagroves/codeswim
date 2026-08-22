// Helpers for the app-aware tools (`open_file`, `get_app_state`).
//
// `open_file` validates its `file` arg before it ever reaches the command
// bridge (tool/command.ts) — this is a cheap client-side rejection, not the
// containment boundary; the bridge's own commands re-validate on the main/
// renderer side regardless. `get_app_state` reads the snapshot the renderer
// publishes to `.codeswim/agent-state.json` and formats it for the model.

import type { AppStateSnapshot, ScreenContextV2 } from '@codeswim/contract'

// Relative to the workspace root. Mirrors apps/desktop/src/main/index.ts.
export const AGENT_STATE_FILE = '.codeswim/agent-state.json'

export function validateOpenFilePath(file: unknown): string | null {
  if (typeof file !== 'string' || file.trim() === '') return 'file is required'
  if (file.startsWith('/')) return 'file must be a path relative to the workspace root'
  if (file.split('/').includes('..')) return 'file must not contain ".."'
  return null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatWorkspaceView(view: 'navigator' | 'kanban' | 'agents'): string {
  return view === 'kanban'
    ? 'Kanban board'
    : view === 'agents'
      ? 'Agents (tabbed agent sessions)'
      : 'diagram navigator'
}

// The unversioned shape published before ScreenContextV2 — see
// AppStateSnapshot's own doc comment for why this still needs handling.
function formatLegacySnapshot(state: AppStateSnapshot): string {
  const lines: string[] = []
  lines.push(`Active tab: ${formatWorkspaceView(state.workspaceView)}`)

  if (state.workspaceView === 'navigator') {
    if (state.currentFile) {
      const kind = state.currentFile.endsWith('.md') ? 'diagram/doc' : 'source file'
      lines.push(`Open file: ${state.currentFile} (${kind})`)
      if (state.currentDocumentPath && state.currentDocumentPath !== state.currentFile) {
        lines.push(`Companion doc: ${state.currentDocumentPath}`)
      }
      lines.push(`View mode: ${state.view}`)
    } else {
      lines.push('No file is open in the navigator.')
    }
    if (Array.isArray(state.breadcrumbs) && state.breadcrumbs.length > 0) {
      lines.push(`Breadcrumb trail: ${state.breadcrumbs.join(' → ')}`)
    }
  }

  if (state.runningScript) lines.push(`Running script: ${state.runningScript}`)
  return lines.join('\n')
}

function formatScreenContextV2(context: ScreenContextV2): string {
  const lines: string[] = []
  lines.push(`Active tab: ${formatWorkspaceView(context.workspaceView)}`)
  lines.push(
    `Focus: ${context.focus.surface}${context.focus.itemId ? ` — ${context.focus.itemId}` : ''}`
  )

  const nav = context.surfaces.navigator
  if (nav) {
    if (nav.currentFile) {
      const kind = nav.currentFile.endsWith('.md') ? 'diagram/doc' : 'source file'
      lines.push(`Open file: ${nav.currentFile} (${kind})`)
      if (nav.currentDocumentPath && nav.currentDocumentPath !== nav.currentFile) {
        lines.push(`Companion doc: ${nav.currentDocumentPath}`)
      }
      lines.push(`View mode: ${nav.view}`)
    } else {
      lines.push('No file is open in the navigator.')
    }
    if (nav.breadcrumbs.length > 0) lines.push(`Breadcrumb trail: ${nav.breadcrumbs.join(' → ')}`)
    if (nav.diagramErrors.length > 0) {
      lines.push(`Diagram render errors: ${nav.diagramErrors.join('; ')}`)
    }
  }

  const kanban = context.surfaces.kanban
  if (kanban) {
    const summary = kanban.columns.map((c) => `${c.name} (${c.cardCount})`).join(', ')
    lines.push(`Kanban columns: ${summary}`)
    lines.push(kanban.openCardId ? `Open card: ${kanban.openCardId}` : 'No card is open.')
    if (kanban.runningCardIds.length > 0) {
      lines.push(`Cards running via "Run all": ${kanban.runningCardIds.join(', ')}`)
    }
  }

  const diff = context.surfaces.diff
  if (diff) {
    const hunks = `${diff.hunkCount} hunk${diff.hunkCount === 1 ? '' : 's'}`
    lines.push(`Diff open: ${diff.path ?? '(none)'} — ${hunks}`)
  }

  const terminal = context.surfaces.terminal
  if (terminal) {
    const tabs = `${terminal.tabCount} tab${terminal.tabCount === 1 ? '' : 's'}`
    lines.push(`Terminal: ${tabs}, active "${terminal.activeTabLabel ?? '(none)'}"`)
  }

  const scriptOutput = context.surfaces.scriptOutput
  if (scriptOutput) {
    lines.push(`Script output (${scriptOutput.name}, ${scriptOutput.status}):`)
    lines.push(...scriptOutput.tail)
  } else if (context.runningScript) {
    lines.push(`Running script: ${context.runningScript.name}`)
  }

  return lines.join('\n')
}

// Parses the published context (or null/garbage) into a compact,
// model-readable summary. Kept separate from the fs read so it's trivially
// testable. Handles four shapes: nothing published, unparseable JSON, the
// current versioned ScreenContextV2, and the legacy unversioned
// AppStateSnapshot (one release of backward compatibility) — anything else
// (valid JSON that matches neither) degrades gracefully rather than
// throwing.
export function formatAppState(raw: string | null): string {
  if (raw == null) {
    return 'No app state has been published yet — the user may not have a workspace open.'
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return 'App state is unavailable (the published snapshot could not be parsed).'
  }
  if (!isPlainObject(parsed)) {
    return 'App state is unavailable (the published snapshot has an unexpected shape).'
  }
  if (parsed.version === 2) {
    return formatScreenContextV2(parsed as unknown as ScreenContextV2)
  }
  if (typeof parsed.workspaceView === 'string') {
    return formatLegacySnapshot(parsed as unknown as AppStateSnapshot)
  }
  return 'App state is unavailable (the published snapshot has an unexpected shape).'
}
