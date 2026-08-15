// PartyServer worker for codeswim per-project chat. One room instance (a
// Cloudflare Durable Object) exists per `roomId` — the hash the app derives
// from the repo's origin remote (see src/main/room.ts), so two clones of the
// same repo connect to the same room with no central registry.
//
// We use PartyServer (Cloudflare's maintained successor to PartyKit) so this
// deploys as a plain Worker to your own account's *.workers.dev subdomain with
// no custom domain. See wrangler.jsonc for the Durable Object binding.
//
// Local dev:   npx wrangler dev          (ws://127.0.0.1:8787)
// Deploy:      npx wrangler deploy        (to codeswim.<subdomain>.workers.dev)
//
// ROOMS: every repo gets two independent rooms (separate history/roster), a
// "collab" room and a "public" room — see roomIdentityFromSlug in
// packages/domain-github/src/room.ts, which derives both ids from the same
// slug via domain-separated hashes (`collab:${slug}` / `public:${slug}`).
// The connecting client picks which one to join with `?mode=collab|public`
// on the websocket URL (default 'collab' if omitted/invalid).
//
//   - mode=public: always open, no auth, regardless of REQUIRE_AUTH — admits
//     immediately with the display name from `?name=`. Anyone who knows the
//     repo slug can lurk and post here. The client also sends `?slug=` so we
//     can confirm hash('public:'+slug) actually matches the room being
//     joined (defense against a client trying to reach the *collab* room's
//     DO instance while claiming mode=public — SHA-256 domain separation
//     means that only succeeds if the claimed slug is the real one, in which
//     case it's the intentionally-public room anyway).
//
//   - mode=collab, gated by the REQUIRE_AUTH var (off locally, on in
//     production):
//       - REQUIRE_AUTH off: admitted immediately with the `?name=` display
//         name — frictionless local dev. Treat such rooms as world-readable.
//       - REQUIRE_AUTH on: the connection is held unauthenticated until it
//         sends an {type:'auth', token, slug} frame. The worker verifies the
//         GitHub token belongs to a listed collaborator of `slug`'s repo AND
//         that hash('collab:'+slug) matches this room (so a token for repo A
//         can't open repo B's room), then admits using the verified GitHub
//         identity. Unauthenticated frames / timeouts are closed. This is
//         collaborator-only even for public repos — read access alone (e.g.
//         anyone forking a public repo) is not sufficient to join; use the
//         public room for that.
// The token arrives in a message, never the URL, so it stays out of edge logs.
//
// PLAIN HTTP: the same room also answers plain GET/POST (no websocket
// upgrade) at the same URL — GET lists recent history, POST sends one
// message. Same room/mode/slug query params, same auth rules (a collab POST
// needs `Authorization: Bearer <token>` instead of the `auth` frame). See
// http.ts. This is what a one-shot caller — e.g. the in-app agent's chat
// tools — uses instead of holding a websocket open.

import {
  Server,
  routePartykitRequest,
  type Connection,
  type ConnectionContext,
  type WSMessage
} from 'partyserver'
import {
  MAX_ROOM_MESSAGES,
  parseClientMessage,
  type ChatMessage,
  type ChatUser,
  type ServerMessage
} from '@codeswim/contract'
import { roomIdForSlug, verifyAccess, type AccessResult, type RoomKind } from './auth'
import { handleRoomHttpRequest } from './http'

interface Env {
  CodeswimRoom: DurableObjectNamespace
  // "true" to require GitHub auth before admitting connections.
  REQUIRE_AUTH?: string
}

const AUTH_TIMEOUT_MS = 10_000

function randomId(): string {
  return crypto.randomUUID()
}

export class CodeswimRoom extends Server<Env> {
  // Stay resident while connections are alive so in-memory history/presence
  // survive (hibernation would evict these maps out from under live sockets).
  static options = { hibernate: false }

  // Recent history kept in memory so a joiner sees context immediately. Per
  // instance and reset if the room fully empties; persisting to storage is a
  // later step.
  private messages: ChatMessage[] = []
  // Presence keyed by connection id — only *admitted* connections appear here.
  private users = new Map<string, ChatUser>()
  // Timers that close connections which never authenticate in time.
  private authTimers = new Map<string, ReturnType<typeof setTimeout>>()

  private requireAuth(): boolean {
    return this.env.REQUIRE_AUTH === 'true'
  }

  private broadcastPresence(): void {
    const payload: ServerMessage = { type: 'presence', users: [...this.users.values()] }
    this.broadcast(JSON.stringify(payload))
  }

  // Admit a connection (auth-gated or open) and send it the room state.
  private admit(conn: Connection, user: ChatUser): void {
    this.users.set(conn.id, user)
    const init: ServerMessage = {
      type: 'init',
      messages: this.messages,
      users: [...this.users.values()]
    }
    conn.send(JSON.stringify(init))
    this.broadcastPresence()
  }

  async onConnect(conn: Connection, ctx: ConnectionContext): Promise<void> {
    const url = new URL(ctx.request.url)
    const mode: RoomKind = url.searchParams.get('mode') === 'public' ? 'public' : 'collab'
    const name = (url.searchParams.get('name') || 'Anonymous').slice(0, 60)

    if (mode === 'public') {
      // Always open — no auth, independent of REQUIRE_AUTH. Just confirm the
      // claimed slug actually hashes to the room we're connecting to (see the
      // file header for why this matters).
      const slug = url.searchParams.get('slug') || ''
      const expected = await roomIdForSlug('public', slug)
      if (expected !== this.name) {
        const err: ServerMessage = {
          type: 'error',
          code: 'room-mismatch',
          message: 'Room does not match the claimed repository.'
        }
        conn.send(JSON.stringify(err))
        conn.close(4004, 'room-mismatch')
        return
      }
      this.admit(conn, { id: conn.id, name, viewing: null })
      return
    }

    if (this.requireAuth()) {
      // Hold the connection until it proves access via an `auth` frame.
      const timer = setTimeout(() => {
        const err: ServerMessage = {
          type: 'error',
          code: 'auth-required',
          message: 'Sign in with GitHub to join this room.'
        }
        conn.send(JSON.stringify(err))
        conn.close(4001, 'auth-required')
        this.authTimers.delete(conn.id)
      }, AUTH_TIMEOUT_MS)
      this.authTimers.set(conn.id, timer)
      return
    }
    // Local dev (auth not required): admit immediately with the display name.
    this.admit(conn, { id: conn.id, name, viewing: null })
  }

  async onMessage(sender: Connection, raw: WSMessage): Promise<void> {
    if (typeof raw !== 'string') return
    const msg = parseClientMessage(raw)
    if (!msg) return

    if (msg.type === 'auth') {
      // Only meaningful while unauthenticated on an auth-gated room.
      if (!this.requireAuth() || this.users.has(sender.id)) return
      let result: AccessResult
      try {
        const expected = await roomIdForSlug('collab', msg.slug)
        result =
          expected === this.name
            ? await verifyAccess(msg.token, msg.slug)
            : { ok: false, reason: 'check-failed' }
      } catch (err) {
        // A thrown verify (e.g. network) must not leave the client hanging —
        // log it and fall through to auth-failed.
        console.error(
          '[auth] verify threw:',
          err instanceof Error ? (err.stack ?? err.message) : err
        )
        result = { ok: false, reason: 'check-failed' }
      }
      const timer = this.authTimers.get(sender.id)
      if (timer) {
        clearTimeout(timer)
        this.authTimers.delete(sender.id)
      }
      if (!result.ok) {
        // Logged server-side (visible via `wrangler tail`) since the reason
        // + GitHub status code is the fastest way to tell "token predates the
        // repo scope" apart from "genuinely not a collaborator" apart from
        // "room/slug mismatch" without the user having to guess.
        console.error('[auth] denied:', result.reason, result.status ?? '')
        const err: ServerMessage = {
          type: 'error',
          code: 'auth-failed',
          reason: result.reason,
          message: 'GitHub did not grant access to this repository.'
        }
        sender.send(JSON.stringify(err))
        sender.close(4003, 'auth-failed')
        return
      }
      const identity = result.identity
      sender.send(JSON.stringify({ type: 'auth-ok' } satisfies ServerMessage))
      this.admit(sender, {
        id: `gh:${identity.id}`,
        name: identity.name || identity.login,
        viewing: null,
        avatarUrl: identity.avatarUrl
      })
      return
    }

    // Everything past here requires an admitted connection.
    const user = this.users.get(sender.id)
    if (!user) return

    if (msg.type === 'chat') {
      const text = msg.text.trim().slice(0, 4000)
      if (!text) return
      this.postMessage({
        id: randomId(),
        userId: user.id,
        name: user.name,
        text,
        sentAt: Date.now()
      })
      return
    }

    if (msg.type === 'viewing') {
      user.viewing = msg.path
      this.broadcastPresence()
    }
  }

  // Append to history and broadcast to live websocket connections. Shared by
  // the websocket `chat` message and the plain-HTTP POST path (onRequest) —
  // both funnel through here so message ordering has one writer.
  private postMessage(message: ChatMessage): void {
    this.messages.push(message)
    if (this.messages.length > MAX_ROOM_MESSAGES) {
      this.messages = this.messages.slice(-MAX_ROOM_MESSAGES)
    }
    // Broadcast to everyone including the sender — clients render from the
    // server echo rather than optimistically.
    const out: ServerMessage = { type: 'message', message }
    this.broadcast(JSON.stringify(out))
  }

  onClose(conn: Connection): void {
    const timer = this.authTimers.get(conn.id)
    if (timer) {
      clearTimeout(timer)
      this.authTimers.delete(conn.id)
    }
    if (this.users.delete(conn.id)) this.broadcastPresence()
  }

  // Plain-HTTP surface for one-shot reads/posts — no websocket handshake, so
  // e.g. the in-app agent's chat tools can check/post without holding a
  // connection open. See http.ts for the shared GET/POST decision logic.
  async onRequest(request: Request): Promise<Response> {
    const outcome = await handleRoomHttpRequest(request, {
      roomName: this.name,
      requireAuth: this.requireAuth(),
      messages: this.messages,
      randomId,
      now: Date.now
    })
    if (outcome.appended) this.postMessage(outcome.appended)
    return Response.json(outcome.body, { status: outcome.status })
  }
}

// Worker entry: route /parties/codeswim-room/:roomId to the Durable Object.
// (routePartykitRequest maps the kebab-cased binding name CodeswimRoom ->
// "codeswim-room" in the URL.)
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routePartykitRequest(request, env as unknown as Record<string, unknown>)) ||
      new Response('Not Found', { status: 404 })
    )
  }
}
