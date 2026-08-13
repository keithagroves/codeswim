// Pure logic for the room's plain-HTTP surface (GET to list recent messages,
// POST to send one), split out of codeswim.ts so it's unit-testable without a
// Durable Object. This is what lets an out-of-band client — e.g. the
// in-app coding agent's `chat_read`/`chat_send` tools — check and post to
// chat without holding a websocket open for a one-shot call.
//
// Same room/auth model as the websocket path (see codeswim.ts's file header):
// `?mode=public|collab&slug=...` picks and verifies the room, and collab
// rooms require a verified GitHub collaborator token when the worker
// enforces auth. This module only decides *what* the response should be; the
// Durable Object (CodeswimRoom.onRequest) is the only thing that actually
// mutates `this.messages` or broadcasts to live websocket connections, so
// message ordering stays single-writer.

import { roomIdForSlug, verifyAccess, type RoomKind } from './auth'
import type { ChatMessage } from '@codeswim/contract'

export interface RoomRequestContext {
  // This Durable Object instance's room name (roomIdForSlug output).
  roomName: string
  requireAuth: boolean
  // Current in-memory history, newest last — never mutated here.
  messages: ChatMessage[]
  randomId: () => string
  now: () => number
}

export interface RoomRequestOutcome {
  status: number
  body: unknown
  // Present only for a successful POST. The caller appends this to its own
  // message list and broadcasts it — this module has no side effects.
  appended?: ChatMessage
}

function parseMode(url: URL): RoomKind {
  return url.searchParams.get('mode') === 'public' ? 'public' : 'collab'
}

export async function handleRoomHttpRequest(
  request: Request,
  ctx: RoomRequestContext
): Promise<RoomRequestOutcome> {
  const url = new URL(request.url)
  const mode = parseMode(url)
  const slug = url.searchParams.get('slug') || ''

  const expected = await roomIdForSlug(mode, slug)
  if (expected !== ctx.roomName) {
    return { status: 400, body: { error: 'room-mismatch' } }
  }

  let name: string
  let userId: string
  if (mode === 'collab' && ctx.requireAuth) {
    const authHeader = request.headers.get('authorization') || ''
    const token = authHeader.replace(/^Bearer\s+/i, '')
    const identity = token ? await verifyAccess(token, slug) : null
    if (!identity) return { status: 403, body: { error: 'auth-failed' } }
    name = identity.name || identity.login
    userId = `gh:${identity.id}`
  } else {
    // Public room, or collab room with auth not enforced (local dev).
    name = (url.searchParams.get('name') || 'Anonymous').slice(0, 60)
    userId = `http:${ctx.randomId()}`
  }

  if (request.method === 'GET') {
    return { status: 200, body: { slug, mode, messages: ctx.messages } }
  }

  if (request.method === 'POST') {
    let payload: { text?: unknown } = {}
    try {
      payload = (await request.json()) as { text?: unknown }
    } catch {
      return { status: 400, body: { error: 'invalid-json' } }
    }
    const text = typeof payload.text === 'string' ? payload.text.trim().slice(0, 4000) : ''
    if (!text) return { status: 400, body: { error: 'text-required' } }
    const message: ChatMessage = { id: ctx.randomId(), userId, name, text, sentAt: ctx.now() }
    return { status: 201, body: { message }, appended: message }
  }

  return { status: 405, body: { error: 'method-not-allowed' } }
}
