// Pure I/O-injected client for the command bridge
// (apps/desktop/src/main/command-server.ts). Mirrors tool/chat.ts's shape:
// config resolved once from env, HTTP I/O injected so this stays testable
// without a real server, no module-level state.

import type { CommandDescriptor, CommandOutcome } from '@codeswim/contract'

export interface CommandConfig {
  url: string
  token: string
}

export interface CommandIo {
  fetch(url: string, init?: RequestInit): Promise<Response>
}

// null when either var is missing — the harness registers no command tools
// in that case, exactly like resolveChatConfig.
export function resolveCommandConfig(env: Record<string, string | undefined>): CommandConfig | null {
  const url = env.CODESWIM_COMMAND_URL
  const token = env.CODESWIM_COMMAND_TOKEN
  if (!url || !token) return null
  return { url, token }
}

export type CommandToolResult<T> = { ok: true; value: T } | { ok: false; error: string }

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function post<T>(
  path: string,
  body: unknown,
  config: CommandConfig,
  io: CommandIo
): Promise<CommandToolResult<T>> {
  let res: Response
  try {
    res = await io.fetch(`${config.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
      body: JSON.stringify(body)
    })
  } catch (err) {
    return { ok: false, error: `could not reach the app: ${errorMessage(err)}` }
  }
  let json: unknown = null
  try {
    json = await res.json()
  } catch {
    // A non-JSON body (e.g. a plain-text 504) falls through to the
    // status-only error message below.
  }
  if (!res.ok) {
    const message =
      json && typeof json === 'object' && 'message' in json && typeof (json as { message: unknown }).message === 'string'
        ? (json as { message: string }).message
        : `request failed (${res.status})`
    return { ok: false, error: message }
  }
  return { ok: true, value: json as T }
}

export async function findCommand(
  query: string,
  sessionId: string,
  worktree: string,
  config: CommandConfig,
  io: CommandIo
): Promise<CommandToolResult<CommandDescriptor[]>> {
  const result = await post<{ commands: CommandDescriptor[] }>(
    '/find',
    { sessionId, worktree, query },
    config,
    io
  )
  if (!result.ok) return result
  return { ok: true, value: result.value.commands }
}

export async function runCommand(
  id: string,
  args: unknown,
  sessionId: string,
  worktree: string,
  config: CommandConfig,
  io: CommandIo
): Promise<CommandToolResult<unknown>> {
  const result = await post<CommandOutcome>('/run', { sessionId, worktree, id, args }, config, io)
  if (!result.ok) return result
  const outcome = result.value
  if (!outcome.ok) return { ok: false, error: outcome.message }
  return { ok: true, value: outcome.value }
}

export function formatCommandList(commands: CommandDescriptor[]): string {
  if (commands.length === 0) return 'No commands matched.'
  return commands.map((c) => `- ${c.id}: ${c.description}`).join('\n')
}
