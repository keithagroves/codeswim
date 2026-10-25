import { OPENER } from './opener'
import { SYSTEM } from './system'
import { WALKTHROUGH } from './walkthrough'

export { FAST, SYSTEM } from './system'
export { OPENER } from './opener'
export { AFTER_OPENER } from './after-opener'
export { WALKTHROUGH, WALKTHROUGH_ADDENDUM } from './walkthrough'

export type NarratorMode = 'opener' | 'main' | 'walkthrough'

/**
 * The opencode agents the narrator runs as, one per mode. Each is a primary
 * agent with every tool disabled. They live in a separate opencode process
 * (apps/desktop/src/main/sidecar.ts, startNarratorSidecar) with no plugin, no
 * instruction files and an empty working directory, so the coding agent's
 * instructions and the workspace's AGENTS.md / CLAUDE.md never reach the
 * narrator. opencode 1.18 appends those after the plugin system-prompt hook
 * runs, so a hook can't strip them (Phase 0 spike).
 */
export const NARRATOR_AGENTS: Record<NarratorMode, string> = {
  opener: 'whiteboard-opener',
  main: 'whiteboard',
  walkthrough: 'whiteboard-walkthrough'
}

/**
 * The `agent` block for the narrator sidecar's opencode config. No model is pinned here; the renderer picks one
 * per request (Pareto when it has a key), the same way the chat does.
 */
export function narratorAgentConfig(): Record<string, unknown> {
  const base = {
    mode: 'primary',
    // `"*": false` strips every tool, built-in and plugin alike (Phase 0
    // spike: the request carried an empty tools list).
    tools: { '*': false },
    temperature: 0.4
  }
  return {
    [NARRATOR_AGENTS.opener]: {
      ...base,
      description: 'Codeswim whiteboard: one quick spoken opening sentence.',
      prompt: OPENER
    },
    [NARRATOR_AGENTS.main]: {
      ...base,
      description: 'Codeswim whiteboard: talks through a design while sketching it.',
      prompt: SYSTEM
    },
    [NARRATOR_AGENTS.walkthrough]: {
      ...base,
      description: 'Codeswim whiteboard: walks through what the coding agent built.',
      prompt: WALKTHROUGH
    }
  }
}

/** Title given to the narrator's hidden sessions: a preset title skips opencode's auto-titling request. */
export const NARRATOR_SESSION_TITLE = 'codeswim:whiteboard'
