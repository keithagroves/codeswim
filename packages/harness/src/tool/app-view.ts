// Helpers for the app-aware tools (`open_file`, `get_app_state`).
//
// `open_file` validates its `file` arg before it ever reaches the command
// bridge (tool/command.ts) — this is a cheap client-side rejection, not the
// containment boundary; the bridge's own commands re-validate on the main/
// renderer side regardless. `get_app_state` reads the snapshot the renderer
// publishes to `.codeswim/agent-state.json` and formats it for the model.

import type { AppStateSnapshot } from '@codeswim/contract'

// Relative to the workspace root. Mirrors apps/desktop/src/main/index.ts.
export const AGENT_STATE_FILE = '.codeswim/agent-state.json'

export function validateOpenFilePath(file: unknown): string | null {
  if (typeof file !== 'string' || file.trim() === '') return 'file is required'
  if (file.startsWith('/')) return 'file must be a path relative to the workspace root'
  if (file.split('/').includes('..')) return 'file must not contain ".."'
  return null
}

// Parses the published snapshot (or null/garbage) into a compact, model-readable
// summary. Kept separate from the fs read so it's trivially testable.
export function formatAppState(raw: string | null): string {
  if (raw == null) {
    return 'No app state has been published yet — the user may not have a workspace open.'
  }
  let state: AppStateSnapshot
  try {
    state = JSON.parse(raw) as AppStateSnapshot
  } catch {
    return 'App state is unavailable (the published snapshot could not be parsed).'
  }

  const lines: string[] = []
  const tabLabel =
    state.workspaceView === 'kanban'
      ? 'Kanban board'
      : state.workspaceView === 'agents'
        ? 'Agents (tabbed agent sessions)'
        : 'diagram navigator'
  lines.push(`Active tab: ${tabLabel}`)

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
