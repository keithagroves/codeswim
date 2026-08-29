// Optional, user-authored SessionStart hooks: shell commands declared in
// `.codeswim/hooks.json` whose stdout gets appended to the agent's system
// prompt. This is what lets a user extend the (otherwise bundled, opinionated)
// prompt per-project without touching the packaged app — e.g. project-specific
// mermaid conventions.
//
// Modeled on Claude Code's hooks: optional, event-triggered, IO-injected so
// it stays testable without spawning real processes. A bad or missing hook
// must never break a session — every failure mode here degrades to "skip it".

import path from 'node:path'

export interface HooksIo {
  readFile(absPath: string): Promise<string>
  exec(
    command: string,
    opts: { cwd: string; timeoutMs: number }
  ): Promise<{ code: number | null; stdout: string }>
}

export interface HookEntry {
  command: string
  timeout?: number
}

export interface HooksConfig {
  hooks?: {
    SessionStart?: HookEntry[]
  }
}

const DEFAULT_TIMEOUT_MS = 5000
const HOOKS_RELATIVE_PATH = path.join('.codeswim', 'hooks.json')

// Tolerant, field-by-field validation — mirrors readCustomRuns in
// apps/desktop/src/main/index.ts. Unknown fields are ignored; malformed
// entries are dropped rather than failing the whole file.
export function parseHooksConfig(raw: string): HooksConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object') return {}
  const hooksField = (parsed as Record<string, unknown>).hooks
  if (!hooksField || typeof hooksField !== 'object') return {}
  const sessionStartField = (hooksField as Record<string, unknown>).SessionStart
  if (!Array.isArray(sessionStartField)) return {}

  const sessionStart: HookEntry[] = []
  for (const entry of sessionStartField) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (typeof e.command !== 'string' || !e.command.trim()) continue
    const hook: HookEntry = { command: e.command }
    if (typeof e.timeout === 'number' && e.timeout > 0) hook.timeout = e.timeout
    sessionStart.push(hook)
  }
  if (sessionStart.length === 0) return {}
  return { hooks: { SessionStart: sessionStart } }
}

export async function readHooksConfig(workspaceRoot: string, io: HooksIo): Promise<HooksConfig> {
  try {
    const raw = await io.readFile(path.join(workspaceRoot, HOOKS_RELATIVE_PATH))
    return parseHooksConfig(raw)
  } catch {
    return {}
  }
}

export async function runSessionStartHooks(
  config: HooksConfig,
  workspaceRoot: string,
  io: HooksIo
): Promise<string[]> {
  const entries = config.hooks?.SessionStart ?? []
  const out: string[] = []
  for (const entry of entries) {
    try {
      const { code, stdout } = await io.exec(entry.command, {
        cwd: workspaceRoot,
        timeoutMs: entry.timeout ?? DEFAULT_TIMEOUT_MS
      })
      if (code !== 0) {
        console.error(`codeswim: SessionStart hook exited ${code}, skipping: ${entry.command}`)
        continue
      }
      const trimmed = stdout.trim()
      if (trimmed) out.push(trimmed)
    } catch (err) {
      console.error(`codeswim: SessionStart hook failed, skipping: ${entry.command}`, err)
    }
  }
  return out
}
