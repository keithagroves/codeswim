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
// AUTH: gated by the REQUIRE_AUTH var (off locally, on in production).
//   - REQUIRE_AUTH off: anyone connecting is admitted with the display name
//     from the `?name=` query — frictionless local dev. Treat such rooms as
//     world-readable.
//   - REQUIRE_AUTH on: a connection is held unauthenticated until it sends an
//     {type:'auth', token, slug} frame. The worker verifies the GitHub token
//     grants access to `slug`'s repo AND that hash(slug) matches this room
//     (so a token for repo A can't open repo B's room), then admits using the
//     verified GitHub identity. Unauthenticated frames / timeouts are closed.
// The token arrives in a message, never the URL, so it stays out of edge logs.

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
} from '../src/shared/chat'

interface Env {
  CodeswimRoom: DurableObjectNamespace
  // "true" to require GitHub auth before admitting connections.
  REQUIRE_AUTH?: string
}

const UA = 'codeswim'
const AUTH_TIMEOUT_MS = 10_000

function randomId(): string {
  return crypto.randomUUID()
}

// Hex SHA-256 of `slug`, first 16 chars — must match roomIdentityFromSlug in
// src/main/room.ts (which uses node:crypto for the identical digest).
async function roomIdForSlug(slug: string): Promise<string> {
  const bytes = new TextEncoder().encode(slug)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
}

interface GitHubIdentity {
  id: number
  login: string
  name: string | null
  avatarUrl: string | null
}

async function githubFetch(path: string, token: string): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': UA
    }
  })
}

// Verifies the token identifies a user AND grants access to the repo named by
// `slug`. Returns the verified identity, or null to reject. For non-github
// hosts we can only verify identity (GitHub can't speak to repo membership on
// another forge), which is a weaker but non-anonymous guarantee.
async function verifyAccess(token: string, slug: string): Promise<GitHubIdentity | null> {
  const userRes = await githubFetch('/user', token)
  if (!userRes.ok) return null
  const u = (await userRes.json()) as {
    id: number
    login: string
    name: string | null
    avatar_url: string | null
  }
  const identity: GitHubIdentity = {
    id: u.id,
    login: u.login,
    name: u.name,
    avatarUrl: u.avatar_url
  }

  const parts = slug.split('/')
  if (parts[0] === 'github.com' && parts.length >= 3) {
    const repoRes = await githubFetch(
      `/repos/${encodeURIComponent(parts[1])}/${encodeURIComponent(parts[2])}`,
      token
    )
    if (!repoRes.ok) return null // 404/403 → no read access
  }
  return identity
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

  onConnect(conn: Connection, ctx: ConnectionContext): void {
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
    // Open room: admit immediately with the query-string display name.
    const url = new URL(ctx.request.url)
    const name = (url.searchParams.get('name') || 'Anonymous').slice(0, 60)
    this.admit(conn, { id: conn.id, name, viewing: null })
  }

  async onMessage(sender: Connection, raw: WSMessage): Promise<void> {
    if (typeof raw !== 'string') return
    const msg = parseClientMessage(raw)
    if (!msg) return

    if (msg.type === 'auth') {
      // Only meaningful while unauthenticated on an auth-gated room.
      if (!this.requireAuth() || this.users.has(sender.id)) return
      let identity: GitHubIdentity | null = null
      try {
        const expected = await roomIdForSlug(msg.slug)
        identity = expected === this.name ? await verifyAccess(msg.token, msg.slug) : null
      } catch (err) {
        // A thrown verify (e.g. network) must not leave the client hanging —
        // log it and fall through to auth-failed.
        console.error('[auth] verify threw:', err instanceof Error ? (err.stack ?? err.message) : err)
      }
      const timer = this.authTimers.get(sender.id)
      if (timer) {
        clearTimeout(timer)
        this.authTimers.delete(sender.id)
      }
      if (!identity) {
        const err: ServerMessage = {
          type: 'error',
          code: 'auth-failed',
          message: 'GitHub did not grant access to this repository.'
        }
        sender.send(JSON.stringify(err))
        sender.close(4003, 'auth-failed')
        return
      }
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
      const message: ChatMessage = {
        id: randomId(),
        userId: user.id,
        name: user.name,
        text,
        sentAt: Date.now()
      }
      this.messages.push(message)
      if (this.messages.length > MAX_ROOM_MESSAGES) {
        this.messages = this.messages.slice(-MAX_ROOM_MESSAGES)
      }
      // Broadcast to everyone including the sender — clients render from the
      // server echo rather than optimistically.
      const out: ServerMessage = { type: 'message', message }
      this.broadcast(JSON.stringify(out))
      return
    }

    if (msg.type === 'viewing') {
      user.viewing = msg.path
      this.broadcastPresence()
    }
  }

  onClose(conn: Connection): void {
    const timer = this.authTimers.get(conn.id)
    if (timer) {
      clearTimeout(timer)
      this.authTimers.delete(conn.id)
    }
    if (this.users.delete(conn.id)) this.broadcastPresence()
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
