// Lets the in-app agent check and post to the project's chat via the party
// server's plain-HTTP surface (party/http.ts) — a one-shot GET/POST, no
// websocket handshake to hold open for a single tool call.
//
// Two rooms per repo, matching the labels in RoomChatPanel's Public/Team
// tabs (apps/desktop/src/renderer/src/components/RoomChatPanel.tsx):
//   'public' -> anyone, no auth
//   'team'   -> GitHub collaborators only, when the deployed worker enforces
//               auth (see party/codeswim.ts's REQUIRE_AUTH)
//
// Room ids/slug/token are resolved once by the host (plugin.ts, from env vars
// the Electron main process threads into the opencode subprocess — see
// apps/desktop/src/main/sidecar.ts) via resolveChatConfig. This module only
// builds requests, interprets responses, and formats tool output; it holds
// no state and does no I/O directly (that's ChatIo, injected by the caller).

export type ChatRoom = 'public' | 'team'

export interface ChatConfig {
  // Host of the deployed party server, no scheme (e.g. '127.0.0.1:8788' or
  // 'codeswim.<sub>.workers.dev').
  partyHost: string
  slug: string
  publicRoomId: string
  teamRoomId: string
  // GitHub token for the 'team' room, or null when not signed in. Reading or
  // posting to 'team' without one fails with a clear message rather than a
  // bare HTTP error.
  token: string | null
  // Display name the agent posts as.
  agentName: string
}

export interface ChatIo {
  fetch(url: string, init?: RequestInit): Promise<Response>
}

export interface ChatMessage {
  id: string
  userId: string
  name: string
  text: string
  sentAt: number
}

export type ChatResult<T> = { ok: true; value: T } | { ok: false; error: string }

// Reads chat config from the opencode subprocess's env. Returns null when
// the workspace has no shared git remote to key a room on (chat unavailable
// here) — see getRoomIdentity in packages/domain-github/src/room.ts, which is
// what the host resolves these values from.
export function resolveChatConfig(env: Record<string, string | undefined>): ChatConfig | null {
  const partyHost = env.CODESWIM_CHAT_PARTY_HOST
  const slug = env.CODESWIM_CHAT_SLUG
  const publicRoomId = env.CODESWIM_CHAT_PUBLIC_ROOM_ID
  const teamRoomId = env.CODESWIM_CHAT_TEAM_ROOM_ID
  if (!partyHost || !slug || !publicRoomId || !teamRoomId) return null
  return {
    partyHost,
    slug,
    publicRoomId,
    teamRoomId,
    token: env.CODESWIM_CHAT_TOKEN || null,
    agentName: env.CODESWIM_CHAT_AGENT_NAME || 'Codeswim Agent'
  }
}

// Team when signed in (more useful — that's presumably where the project's
// real conversation happens), else public.
export function defaultRoom(config: ChatConfig): ChatRoom {
  return config.token ? 'team' : 'public'
}

export function validateChatRoom(room: unknown): string | null {
  return room === 'public' || room === 'team'
    ? null
    : `room must be "public" or "team" (got ${JSON.stringify(room)})`
}

function isLoopback(host: string): boolean {
  return /^(127\.0\.0\.1|localhost)(:|$)/.test(host)
}

function roomUrl(config: ChatConfig, room: ChatRoom): URL {
  const roomId = room === 'public' ? config.publicRoomId : config.teamRoomId
  const proto = isLoopback(config.partyHost) ? 'http' : 'https'
  const url = new URL(
    `${proto}://${config.partyHost}/parties/codeswim-room/${encodeURIComponent(roomId)}`
  )
  url.searchParams.set('mode', room === 'public' ? 'public' : 'collab')
  url.searchParams.set('slug', config.slug)
  return url
}

function authHeaders(config: ChatConfig, room: ChatRoom): Record<string, string> {
  return room === 'team' && config.token ? { authorization: `Bearer ${config.token}` } : {}
}

async function describeError(res: Response, room: ChatRoom): Promise<string> {
  if (res.status === 403) {
    return `Not authorized for the ${room} room — sign in with GitHub and make sure you're a collaborator on this repo.`
  }
  if (res.status === 400) {
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error === 'room-mismatch') {
        return 'This workspace’s chat room configuration looks stale — try restarting the agent.'
      }
    } catch {
      // fall through to the generic message below
    }
  }
  return `Chat request failed (HTTP ${res.status}).`
}

export async function readChat(
  room: ChatRoom,
  config: ChatConfig,
  io: ChatIo
): Promise<ChatResult<ChatMessage[]>> {
  if (room === 'team' && !config.token) {
    return {
      ok: false,
      error: 'Not signed in with GitHub — cannot read the team room. Try room="public" instead.'
    }
  }
  const res = await io.fetch(roomUrl(config, room).toString(), {
    headers: authHeaders(config, room)
  })
  if (!res.ok) return { ok: false, error: await describeError(res, room) }
  const body = (await res.json()) as { messages?: ChatMessage[] }
  return { ok: true, value: Array.isArray(body.messages) ? body.messages : [] }
}

export async function sendChat(
  room: ChatRoom,
  text: string,
  config: ChatConfig,
  io: ChatIo
): Promise<ChatResult<ChatMessage>> {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, error: 'text is required' }
  if (room === 'team' && !config.token) {
    return { ok: false, error: 'Not signed in with GitHub — cannot post to the team room.' }
  }
  const url = roomUrl(config, room)
  url.searchParams.set('name', config.agentName)
  const res = await io.fetch(url.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(config, room) },
    body: JSON.stringify({ text: trimmed })
  })
  if (!res.ok) return { ok: false, error: await describeError(res, room) }
  const body = (await res.json()) as { message: ChatMessage }
  return { ok: true, value: body.message }
}

export function formatMessages(room: ChatRoom, messages: ChatMessage[]): string {
  if (messages.length === 0) return `No messages yet in the ${room} room.`
  const lines = messages.map((m) => `[${new Date(m.sentAt).toISOString()}] ${m.name}: ${m.text}`)
  return `${room} room (${messages.length} message${messages.length === 1 ? '' : 's'}):\n${lines.join('\n')}`
}
