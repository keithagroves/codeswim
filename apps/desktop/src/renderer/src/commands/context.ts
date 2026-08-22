import type { Dispatch } from 'react'
import type { CommandDanger, CommandOrigin, DiagramNavApi, KanbanCard } from '@codeswim/contract'
import type { AppState } from '../store'
import type { Action } from '../state'

// Everything a command handler is given at invocation time. Built fresh by
// the registry's CommandCtxFactory for every `run` call — never captured
// once and reused — so a handler always sees the live state and roots, not
// whatever was current when the registry (or an earlier call) was built.
export interface CommandCtx {
  getState(): AppState
  dispatch: Dispatch<Action>
  api: DiagramNavApi
  toast(message: string, kind?: 'info' | 'error'): void
  origin: CommandOrigin
  // Root of the workspace the human has open, regardless of origin. View-only
  // commands may read this (or getState().rootPath, equivalently).
  activeRoot: string | null
  // Root a filesystem command must use: activeRoot for human origin, the
  // agent's validated worktree for agent origin. Never mix these up — an
  // agent-origin filesystem command that reads activeRoot instead would let
  // an agent reach outside the worktree it was scoped to.
  executionRoot: string | null
  // Approval gate for commands with a `danger`. Human calls resolve through
  // an injected confirmation adapter (window.confirm today); agent calls
  // resolve false unless a future approval service grants a scoped
  // exception — see plans/command-bus-and-screen-context.md Phase 4.
  confirm(danger: CommandDanger, summary: string): Promise<boolean>
  // Starts an agent on a card inside an isolated worktree, awaiting its first
  // reply. Only used by agent:'never' commands (kanban.runCard/runColumn) —
  // an agent-reachable command must never call this, to avoid a tool
  // recursively spawning another agent session (see plans/
  // command-bus-and-screen-context.md Phase 5).
  startAgentInWorktree(card: KanbanCard, directory: string): Promise<void>
}

export type CommandCtxFactory = (origin: CommandOrigin) => CommandCtx
