// Renderer-side chat client: a thin reconnecting WebSocket wrapper around the
// PartyKit room, exposed as a React hook. We talk plain WebSocket (no
// `partysocket` dependency) so the renderer pulls in nothing new and works
// against the local `partykit dev` server out of the box.
//
// AUTH SEAM: connection currently authenticates with nothing and passes a
// display name in the query string. When GitHub auth lands, fetch a per-room
// token from main and append it here (`&token=...`); the server's
// onBeforeConnect will verify it.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  parseServerMessage,
  type ChatMessage,
  type ChatUser,
  type ClientMessage
} from '../../../shared/chat'

// Host of the PartyKit server. Defaults to the local dev server; override with
// VITE_PARTY_HOST (e.g. "codeswim.<account>.partykit.dev" or a custom
// codeswim.xyz domain) for a deployed server.
const PARTY_HOST = (import.meta.env.VITE_PARTY_HOST as string | undefined) ?? '127.0.0.1:1999'

export type ChatStatus = 'connecting' | 'open' | 'closed'

function socketUrl(roomId: string, name: string): string {
  const secure = !/^(127\.0\.0\.1|localhost)(:|$)/.test(PARTY_HOST)
  const proto = secure ? 'wss' : 'ws'
  // PartyKit routes the default party's rooms under /parties/main/<room>.
  const params = new URLSearchParams({ name })
  return `${proto}://${PARTY_HOST}/parties/main/${encodeURIComponent(roomId)}?${params}`
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
export function useRoomChat(roomId: string | null, name: string): RoomChat {
  const [status, setStatus] = useState<ChatStatus>('connecting')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [users, setUsers] = useState<ChatUser[]>([])

  const wsRef = useRef<WebSocket | null>(null)
  // Last 'viewing' path, resent on reconnect so presence survives a drop.
  const viewingRef = useRef<string | null>(null)
  const retryRef = useRef(0)

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

    const connect = (): void => {
      setStatus('connecting')
      const ws = new WebSocket(socketUrl(roomId, name))
      wsRef.current = ws

      ws.onopen = () => {
        retryRef.current = 0
        setStatus('open')
        // Re-announce what we're viewing after a reconnect.
        if (viewingRef.current !== null) {
          ws.send(JSON.stringify({ type: 'viewing', path: viewingRef.current }))
        }
      }

      ws.onmessage = (event) => {
        const msg = parseServerMessage(String(event.data))
        if (!msg) return
        if (msg.type === 'init') {
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
  }, [roomId, name])

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
