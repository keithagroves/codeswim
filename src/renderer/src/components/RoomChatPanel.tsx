import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { useRoomChat } from '../chat/connection'
import type { RoomIdentity } from '../../../preload/index.d'

const NAME_KEY = 'codeswim:chatName'

function shortPath(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}

function timeLabel(sentAt: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(sentAt)
}

export function RoomChatPanel(): React.JSX.Element {
  const { state, navigateAbsolute } = useStore()
  const rootPath = state.rootPath
  const [identity, setIdentity] = useState<RoomIdentity | null>(null)
  const [identityLoaded, setIdentityLoaded] = useState(false)
  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) ?? '')
  const [nameDraft, setNameDraft] = useState('')
  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLDivElement | null>(null)

  // Resolve the room identity for this workspace (derived from the git remote
  // in main). null = no shared remote, so chat is unavailable here.
  useEffect(() => {
    if (!rootPath) {
      // Reset for the no-workspace render; loading a workspace re-runs this.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIdentity(null)
      setIdentityLoaded(true)
      return
    }
    let cancelled = false
    setIdentityLoaded(false)
    void window.api
      .roomIdentity(rootPath)
      .then((id) => {
        if (!cancelled) {
          setIdentity(id)
          setIdentityLoaded(true)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setIdentity(null)
          setIdentityLoaded(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [rootPath])

  // Only connect once we have both a room and a chosen name.
  const roomId = name.trim() && identity ? identity.roomId : null
  const { status, messages, users, send, setViewing } = useRoomChat(roomId, name.trim())

  // Broadcast the currently-open file as presence so teammates see what
  // diagram we're looking at.
  useEffect(() => {
    setViewing(state.currentFile)
  }, [state.currentFile, setViewing])

  // Keep the message list pinned to the latest message.
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const others = useMemo(() => users.filter((u) => u.viewing), [users])

  if (!identityLoaded) {
    return <div className="chat-panel chat-empty">Loading…</div>
  }

  if (!rootPath) {
    return <div className="chat-panel chat-empty">Open a workspace to chat.</div>
  }

  if (!identity) {
    return (
      <div className="chat-panel chat-empty">
        <p>Chat needs a shared git remote.</p>
        <p className="chat-empty-hint">
          Add an <code>origin</code> remote (e.g. push this repo to GitHub) so everyone who clones
          it joins the same room.
        </p>
      </div>
    )
  }

  if (!name.trim()) {
    return (
      <div className="chat-panel chat-empty">
        <form
          className="chat-name-form"
          onSubmit={(e) => {
            e.preventDefault()
            const trimmed = nameDraft.trim()
            if (!trimmed) return
            localStorage.setItem(NAME_KEY, trimmed)
            setName(trimmed)
          }}
        >
          <label htmlFor="chat-name">Choose a display name</label>
          <input
            id="chat-name"
            autoFocus
            value={nameDraft}
            placeholder="e.g. Sam"
            onChange={(e) => setNameDraft(e.target.value)}
          />
          <button className="primary" type="submit" disabled={!nameDraft.trim()}>
            Join {identity.slug}
          </button>
        </form>
      </div>
    )
  }

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <div className="chat-room-name" title={identity.slug}>
          {identity.slug}
        </div>
        <div className={`chat-status chat-status-${status}`}>
          {status === 'open'
            ? `${users.length} online`
            : status === 'connecting'
              ? 'Connecting…'
              : 'Offline'}
        </div>
      </div>

      {others.length > 0 ? (
        <div className="chat-presence">
          {others.map((u) => (
            <button
              key={u.id}
              className="chat-presence-item"
              title={`${u.name} is viewing ${u.viewing}`}
              onClick={() => u.viewing && void navigateAbsolute(u.viewing, true)}
            >
              <span className="chat-presence-name">{u.name}</span>
              <span className="chat-presence-file">{shortPath(u.viewing as string)}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="chat-messages" ref={listRef}>
        {messages.length === 0 ? (
          <div className="chat-empty-hint">No messages yet — say hello.</div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className="chat-message">
              <div className="chat-message-meta">
                <span className="chat-message-author">{m.name}</span>
                <span className="chat-message-time">{timeLabel(m.sentAt)}</span>
              </div>
              <div className="chat-message-text">{m.text}</div>
            </div>
          ))
        )}
      </div>

      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault()
          send(draft)
          setDraft('')
        }}
      >
        <input
          value={draft}
          placeholder={status === 'open' ? 'Message…' : 'Reconnecting…'}
          disabled={status !== 'open'}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button className="primary" type="submit" disabled={status !== 'open' || !draft.trim()}>
          Send
        </button>
      </form>
    </div>
  )
}
