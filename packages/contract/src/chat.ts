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
  // GitHub avatar URL when the room authenticated the user, else null/absent.
  avatarUrl?: string | null
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
  // First frame when the room requires auth: a GitHub token plus the repo slug
  // the room claims to be. The server verifies the token grants access to that
  // repo and that hash(slug) matches the room before admitting the connection.
  // Sent as a message (not a URL param) so the token never lands in edge logs.
  | { type: 'auth'; token: string; slug: string }
  | { type: 'chat'; text: string }
  | { type: 'viewing'; path: string | null }

// Why a collab-room auth attempt was rejected — surfaced on 'auth-failed' so
// the client can show something more actionable than a flat "denied":
//   'bad-token'          — GET /user failed; the token is invalid/expired.
//   'not-collaborator'   — the token identifies a real user who genuinely
//                          isn't a collaborator on this repo (GitHub 404).
//   'insufficient-scope' — the token's identity check for collaborator
//                          status was itself refused (GitHub 403) — usually
//                          means the token predates the `repo` OAuth scope.
//   'check-failed'       — anything else (room/slug mismatch, network error,
//                          unexpected GitHub response).
export type AccessDenialReason =
  | 'bad-token'
  | 'not-collaborator'
  | 'insufficient-scope'
  | 'check-failed'

// Server → client.
export type ServerMessage =
  // Auth accepted; the client may now treat the connection as ready. Only sent
  // on rooms that require auth (open rooms send `init` straight away).
  | { type: 'auth-ok' }
  // Auth rejected (or required but not provided). The client should stop
  // reconnecting and prompt the user to sign in.
  // 'room-mismatch': the claimed room kind + slug didn't hash to the room
  // being joined (client bug, or an attempt to reach the collab room's
  // history via the public join path). Also terminal — stop reconnecting.
  | {
      type: 'error'
      code: 'auth-required' | 'auth-failed' | 'room-mismatch'
      message: string
      reason?: AccessDenialReason
    }
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
  if (
    msg.type === 'init' ||
    msg.type === 'message' ||
    msg.type === 'presence' ||
    msg.type === 'auth-ok' ||
    msg.type === 'error'
  ) {
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
  if (msg.type === 'auth' && typeof msg.token === 'string' && typeof msg.slug === 'string') {
    return { type: 'auth', token: msg.token, slug: msg.slug }
  }
  if (msg.type === 'chat' && typeof msg.text === 'string') {
    return { type: 'chat', text: msg.text }
  }
  if (msg.type === 'viewing' && (typeof msg.path === 'string' || msg.path === null)) {
    return { type: 'viewing', path: msg.path as string | null }
  }
  return null
}
