// Wire protocol for the per-project chat rooms, shared by the PartyKit server
// (party/codeswim.ts) and the renderer client. Pure types + small helpers, no
// runtime dependencies, so both build targets can import it.

// A participant in a room. `id` is the stable connection identity; in the
// local-dev / anonymous build it's a random per-session id, and once GitHub
// auth lands it becomes the GitHub user id so presence survives reconnects.
export interface ChatUser {
  id: string
  name: string
  // POSIX-relative path of the diagram/file this user is currently viewing,
  // or null. Drives the "Sam is viewing architecture/auth.md" presence.
  viewing: string | null
}

export interface ChatMessage {
  id: string
  userId: string
  // Author name captured at send time, so old messages render correctly even
  // after a user changes their display name.
  name: string
  text: string
  // Epoch millis, assigned by the server (clients don't set their own time).
  sentAt: number
}

// Client → server.
export type ClientMessage =
  | { type: 'chat'; text: string }
  | { type: 'viewing'; path: string | null }

// Server → client.
export type ServerMessage =
  // Full state on join: recent history + current roster.
  | { type: 'init'; messages: ChatMessage[]; users: ChatUser[] }
  | { type: 'message'; message: ChatMessage }
  | { type: 'presence'; users: ChatUser[] }

// How many messages a room keeps in memory and replays to joiners.
export const MAX_ROOM_MESSAGES = 50

// Parse a server frame on the client. The server is trusted, so this only
// guards against malformed JSON and unknown shapes rather than deep-validating
// every field.
export function parseServerMessage(raw: string): ServerMessage | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const msg = value as { type?: unknown }
  if (msg.type === 'init' || msg.type === 'message' || msg.type === 'presence') {
    return value as ServerMessage
  }
  return null
}

export function parseClientMessage(raw: string): ClientMessage | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const msg = value as Record<string, unknown>
  if (msg.type === 'chat' && typeof msg.text === 'string') {
    return { type: 'chat', text: msg.text }
  }
  if (msg.type === 'viewing' && (typeof msg.path === 'string' || msg.path === null)) {
    return { type: 'viewing', path: msg.path as string | null }
  }
  return null
}
