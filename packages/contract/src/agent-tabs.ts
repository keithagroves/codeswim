// Persisted Agents-view tab strip — see apps/desktop/src/main/agent-tabs-file.ts
// (file I/O) and state.tsx's ensureAgent (restore) / persistence effect
// (write). Only enough to rebuild the tab strip is kept here (id, opencode
// sessionId, title); message history lives server-side in opencode and is
// re-fetched per tab via agent.loadMessages(sessionId) on restore, so this
// file stays tiny regardless of how long conversations get.

export interface PersistedAgentTab {
  id: string
  sessionId: string | null
  title: string
  // Working directory override (a Kanban "Run all" git worktree), or
  // undefined/null for an ordinary tab scoped to the workspace root.
  directory?: string | null
}

export interface PersistedAgentTabs {
  tabs: PersistedAgentTab[]
  activeAgentTabId: string | null
}

// Pure parse/validate so both main (reading the file) and the renderer can
// share it. Tolerant of missing/malformed data — never throws, and drops
// individually malformed tab entries rather than rejecting the whole file.
export function normalizePersistedAgentTabs(value: unknown): PersistedAgentTabs | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (!Array.isArray(v.tabs)) return null

  const tabs: PersistedAgentTab[] = []
  for (const entry of v.tabs) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    if (typeof e.id !== 'string' || typeof e.title !== 'string') continue
    if (typeof e.sessionId !== 'string' && e.sessionId !== null) continue
    const directory = typeof e.directory === 'string' ? e.directory : null
    tabs.push({ id: e.id, sessionId: e.sessionId, title: e.title, directory })
  }
  if (tabs.length === 0) return null

  const activeAgentTabId =
    typeof v.activeAgentTabId === 'string' && tabs.some((t) => t.id === v.activeAgentTabId)
      ? v.activeAgentTabId
      : (tabs[0]?.id ?? null)
  return { tabs, activeAgentTabId }
}
