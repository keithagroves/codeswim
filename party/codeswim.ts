// PartyKit server for codeswim per-project chat. One room instance (a
// Cloudflare Durable Object under the hood) exists per `roomId` — the hash the
// app derives from the repo's origin remote (see src/main/room.ts), so two
// clones of the same repo connect to the same room with no central registry.
//
// Local dev:   npx partykit dev          (ws://127.0.0.1:1999)
// Deploy:      npx partykit deploy        (to *.codeswim.xyz, see partykit.json)
//
// AUTH: this scaffold admits anyone who connects and takes the display name
// from the connection query string. The `onBeforeConnect` hook below is the
// seam where GitHub OAuth + repo-access verification will slot in — it should
// validate a room token and reject unauthorized joins. Until then, treat rooms
// as world-readable and don't put anything sensitive in them.

import type * as Party from 'partykit/server'
import {
  MAX_ROOM_MESSAGES,
  parseClientMessage,
  type ChatMessage,
  type ChatUser,
  type ServerMessage
} from '../src/shared/chat'

function randomId(): string {
  return crypto.randomUUID()
}

export default class CodeswimRoom implements Party.Server {
  // Keep recent history in memory so a joiner sees context immediately. For a
  // scaffold this is per-instance and resets if the room hibernates with no
  // connections; persisting to room.storage is a later step.
  private messages: ChatMessage[] = []
  // Presence keyed by connection id.
  private users = new Map<string, ChatUser>()

  constructor(readonly room: Party.Room) {}

  private broadcastPresence(): void {
    const payload: ServerMessage = { type: 'presence', users: [...this.users.values()] }
    this.room.broadcast(JSON.stringify(payload))
  }

  onConnect(conn: Party.Connection, ctx: Party.ConnectionContext): void {
    const url = new URL(ctx.request.url)
    const name = (url.searchParams.get('name') || 'Anonymous').slice(0, 60)
    this.users.set(conn.id, { id: conn.id, name, viewing: null })

    // Replay history + roster to the new connection only.
    const init: ServerMessage = {
      type: 'init',
      messages: this.messages,
      users: [...this.users.values()]
    }
    conn.send(JSON.stringify(init))
    this.broadcastPresence()
  }

  onMessage(raw: string, sender: Party.Connection): void {
    const msg = parseClientMessage(raw)
    if (!msg) return
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
      const out: ServerMessage = { type: 'message', message }
      this.room.broadcast(JSON.stringify(out))
      return
    }

    if (msg.type === 'viewing') {
      user.viewing = msg.path
      this.broadcastPresence()
    }
  }

  onClose(conn: Party.Connection): void {
    this.users.delete(conn.id)
    this.broadcastPresence()
  }
}
