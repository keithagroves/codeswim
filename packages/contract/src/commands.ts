// Wire/registry types for the command bus (see plans/command-bus-and-screen-context.md).
// One registry, in apps/desktop/src/renderer/src/commands/, is the single place UI
// components, keybindings, and the out-of-process agent invoke behavior through.
// This file is the versioned seam: pure types, no runtime dependencies, so the
// harness side (packages/harness) can describe/validate requests without
// importing renderer code.

// Structural JSON Schema — enough to describe a command's args shape and
// validate them at the registry boundary. Not a general JSON Schema
// implementation: no $ref, no combinators, no format keywords. Semantic
// validation (paths, current selection, cross-field rules) is a command's
// own `validate`, not this.
export interface JSONSchema {
  type?: 'object' | 'string' | 'number' | 'boolean' | 'array' | 'null'
  properties?: Record<string, JSONSchema>
  required?: string[]
  items?: JSONSchema
  enum?: Array<string | number | boolean | null>
  description?: string
  nullable?: boolean
}

// Who is invoking a command. Human calls run against the active workspace;
// agent calls are scoped to the caller's own validated worktree — a command
// touching the filesystem must use the origin's root, never the human's.
export type CommandOrigin =
  | { kind: 'human' }
  | { kind: 'agent'; sessionId: string; worktree: string }

// Disclosure tier for the agent's `find_command`/`run_command` tools:
//   'hot'    — described directly in a tool's own description (e.g. open_file)
//   'listed' — reachable via find_command search, not preloaded
//   'never'  — not reachable by an agent origin at all, enforced by the
//              registry regardless of how the call arrives
export type CommandAgentTier = 'hot' | 'listed' | 'never'

export interface CommandDanger {
  kind: 'destructive' | 'network'
}

// The static, serializable half of a Command (see commands/registry.ts for
// the runtime half — validate/run are functions and don't cross the wire).
export interface CommandDescriptor {
  id: string
  domain: string
  title: string
  description: string
  schema: JSONSchema
  agent: CommandAgentTier
  danger?: CommandDanger
}

export interface CommandRequest<A = unknown> {
  id: string
  args: A
  origin: CommandOrigin
}

export interface CommandResult<R = unknown> {
  ok: true
  value: R
}

export type CommandErrorCode =
  | 'unknown-command'
  | 'duplicate-command'
  | 'invalid-args'
  | 'forbidden-origin'
  | 'denied'
  | 'handler-error'

export interface CommandErrorPayload {
  ok: false
  code: CommandErrorCode
  message: string
}

export type CommandOutcome<R = unknown> = CommandResult<R> | CommandErrorPayload

// The main<->renderer proxy protocol behind the command bridge
// (apps/desktop/src/main/command-server.ts): main asks over the
// 'command:request' IPC event, the renderer answers by invoking
// 'command:reply' with the same `id`. Correlates a loopback HTTP request
// from the harness sidecar's find_command/run_command tools
// (packages/harness/src/tool/command.ts) to the renderer's own
// CommandRegistry, which is the only place a command actually runs.
export type CommandRendererRequest =
  | { id: string; kind: 'find'; query: string }
  | {
      id: string
      kind: 'run'
      commandId: string
      args: unknown
      origin: { kind: 'agent'; sessionId: string; worktree: string }
    }

export type CommandRendererResponse =
  | { id: string; kind: 'find'; commands: CommandDescriptor[] }
  | { id: string; kind: 'run'; outcome: CommandOutcome }
