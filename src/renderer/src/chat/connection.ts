// Renderer-side chat client: a thin reconnecting WebSocket wrapper around the
// PartyServer room, exposed as a React hook. We talk plain WebSocket (no
// `partysocket` dependency) so the renderer pulls in nothing new and works
// against the local `wrangler dev` server out of the box.
//
// AUTH: pass `auth` (a GitHub token + repo slug) to join an auth-gated room.
// We send it as the first frame after the socket opens — never in the URL, so
// the token stays out of edge logs — and wait for `auth-ok` before treating
// the connection as ready. An `error` frame means the server rejected us
// (not signed in / no repo access): we surface 'denied' and stop reconnecting.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  parseServerMessage,
  type ChatMessage,
  type ChatUser,
  type ClientMessage
} from '../../../shared/chat'

// Host of the PartyServer worker. Defaults to the local `wrangler dev` server;
// override with VITE_PARTY_HOST (e.g. "codeswim.<subdomain>.workers.dev") for
// the deployed server.
const PARTY_HOST = (import.meta.env.VITE_PARTY_HOST as string | undefined) ?? '127.0.0.1:8787'

export type ChatStatus = 'connecting' | 'open' | 'closed' | 'denied'

// Credentials for an auth-gated room: a GitHub token and the repo slug the
// room claims to be (the server checks both).
export interface RoomAuth {
  slug: string
  token: string
}

function socketUrl(roomId: string, name: string): string {
  const secure = !/^(127\.0\.0\.1|localhost)(:|$)/.test(PARTY_HOST)
  const proto = secure ? 'wss' : 'ws'
  // PartyServer routes the CodeswimRoom binding's rooms under
  // /parties/codeswim-room/<room> (binding name kebab-cased).
  const params = new URLSearchParams({ name })
  return `${proto}://${PARTY_HOST}/parties/codeswim-room/${encodeURIComponent(roomId)}?${params}`
}

export interface RoomChat {
  status: ChatStatus
  messages: ChatMessage[]
  users: ChatUser[]
  send(text: string): void
  setViewing(path: string | null): void
}

// Connects to `roomId` as `name` and keeps the connection alive across drops.
// Passing roomId=null (no shared remote) leaves the hook idle and closed.
// Pass `auth` to join a room that requires GitHub sign-in.
export function useRoomChat(
  roomId: string | null,
  name: string,
  auth: RoomAuth | null = null
): RoomChat {
  const [status, setStatus] = useState<ChatStatus>('connecting')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [users, setUsers] = useState<ChatUser[]>([])

  const wsRef = useRef<WebSocket | null>(null)
  // Last 'viewing' path, resent on reconnect so presence survives a drop.
  const viewingRef = useRef<string | null>(null)
  const retryRef = useRef(0)

  // Depend on primitives so a fresh `auth` object identity each render doesn't
  // thrash the connection.
  const token = auth?.token ?? null
  const slug = auth?.slug ?? null

  const sendRaw = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }, [])

  useEffect(() => {
    if (!roomId) {
      // No room to join (no shared remote, or no name yet) — stay closed.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStatus('closed')
      return
    }
    let closedByUs = false
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined

    // Transition to ready: mark open and re-announce viewing (survives drops).
    const becomeReady = (ws: WebSocket): void => {
      retryRef.current = 0
      setStatus('open')
      if (viewingRef.current !== null) {
        ws.send(JSON.stringify({ type: 'viewing', path: viewingRef.current }))
      }
    }

    const connect = (): void => {
      setStatus('connecting')
      const ws = new WebSocket(socketUrl(roomId, name))
      wsRef.current = ws

      ws.onopen = () => {
        if (token && slug) {
          // Auth-gated: send credentials first, stay 'connecting' until ok.
          ws.send(JSON.stringify({ type: 'auth', token, slug }))
        } else {
          becomeReady(ws)
        }
      }

      ws.onmessage = (event) => {
        const msg = parseServerMessage(String(event.data))
        if (!msg) return
        if (msg.type === 'auth-ok') {
          becomeReady(ws)
        } else if (msg.type === 'error') {
          // Rejected — don't churn through reconnects against a closed door.
          closedByUs = true
          setStatus('denied')
          ws.close()
        } else if (msg.type === 'init') {
          setMessages(msg.messages)
          setUsers(msg.users)
        } else if (msg.type === 'message') {
          setMessages((prev) => [...prev, msg.message])
        } else if (msg.type === 'presence') {
          setUsers(msg.users)
        }
      }

      ws.onclose = () => {
        wsRef.current = null
        if (closedByUs) return
        setStatus('closed')
        // Exponential backoff, capped at 10s.
        const delay = Math.min(1000 * 2 ** retryRef.current, 10000)
        retryRef.current += 1
        reconnectTimer = setTimeout(connect, delay)
      }
    }

    connect()

    return () => {
      closedByUs = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [roomId, name, token, slug])

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (trimmed) sendRaw({ type: 'chat', text: trimmed })
    },
    [sendRaw]
  )

  const setViewing = useCallback(
    (path: string | null) => {
      if (viewingRef.current === path) return
      viewingRef.current = path
      sendRaw({ type: 'viewing', path })
    },
    [sendRaw]
  )

  return { status, messages, users, send, setViewing }
}
