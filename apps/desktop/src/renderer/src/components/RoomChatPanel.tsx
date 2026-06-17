import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { useRoomChat } from '../chat/connection'
import type { GitHubStatus, RoomIdentity } from '@codeswim/contract'

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
  // GitHub auth state. null = still loading.
  const [github, setGithub] = useState<GitHubStatus | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [device, setDevice] = useState<{ userCode: string; verificationUri: string } | null>(null)
  const [signInError, setSignInError] = useState<string | null>(null)
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

  // Load GitHub auth status once and subscribe to sign-in/out changes (the
  // device-flow approval lands asynchronously).
  useEffect(() => {
    let cancelled = false
    void window.api.githubStatus().then((s) => {
      if (!cancelled) setGithub(s)
    })
    const off = window.api.onGitHubAuthChanged((user) => {
      setGithub((prev) => ({ configured: prev?.configured ?? true, user }))
      if (user) setDevice(null)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [])

  const user = github?.user ?? null
  const configured = github?.configured ?? false

  // Fetch the access token whenever we're signed in (and clear it on sign-out).
  useEffect(() => {
    if (!user) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setToken(null)
      return
    }
    let cancelled = false
    void window.api.githubToken().then((t) => {
      if (!cancelled) setToken(t)
    })
    return () => {
      cancelled = true
    }
  }, [user])

  // Connection model:
  //   configured + signed in  -> auth-gated, identity from GitHub
  //   not configured          -> anonymous with a manual display name
  //   configured + signed out  -> no connection (prompt sign-in)
  const displayName = user ? user.name || user.login : name.trim()
  const auth = useMemo(
    () => (user && token && identity ? { slug: identity.slug, token } : null),
    [user, token, identity]
  )
  const wantConnect = Boolean(identity && (user ? !!token : !configured && !!name.trim()))
  const roomId = wantConnect && identity ? identity.roomId : null
  const { status, messages, users, send, setViewing } = useRoomChat(roomId, displayName, auth)

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

  const signIn = async (): Promise<void> => {
    setSignInError(null)
    const res = await window.api.githubSignIn()
    if ('error' in res) setSignInError(res.error)
    else setDevice(res)
  }

  if (!identityLoaded || github === null) {
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

  // Auth-gated: configured but not signed in.
  if (configured && !user) {
    return (
      <div className="chat-panel chat-empty">
        <div className="chat-signin">
          <p>Sign in with GitHub to join the room for</p>
          <p className="chat-room-name" title={identity.slug}>
            {identity.slug}
          </p>
          {device ? (
            <div className="chat-device">
              <p className="chat-empty-hint">
                Enter this code at{' '}
                <a href={device.verificationUri} target="_blank" rel="noreferrer">
                  {device.verificationUri.replace(/^https?:\/\//, '')}
                </a>
                :
              </p>
              <div className="chat-device-code">{device.userCode}</div>
              <p className="chat-empty-hint">Waiting for authorization…</p>
            </div>
          ) : (
            <button className="primary" type="button" onClick={() => void signIn()}>
              Sign in with GitHub
            </button>
          )}
          {signInError ? <p className="chat-error">{signInError}</p> : null}
        </div>
      </div>
    )
  }

  // Anonymous fallback (GitHub not configured): pick a display name.
  if (!configured && !name.trim()) {
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
        <div className="chat-header-right">
          <div className={`chat-status chat-status-${status}`}>
            {status === 'open'
              ? `${users.length} online`
              : status === 'connecting'
                ? 'Connecting…'
                : status === 'denied'
                  ? 'Access denied'
                  : 'Offline'}
          </div>
          {user ? (
            <button
              className="chat-signout"
              type="button"
              title={`Signed in as ${user.login} — sign out`}
              onClick={() => void window.api.githubSignOut()}
            >
              {user.avatarUrl ? <img className="chat-avatar" src={user.avatarUrl} alt="" /> : null}
              Sign out
            </button>
          ) : null}
        </div>
      </div>

      {status === 'denied' ? (
        <div className="chat-error chat-denied">
          GitHub didn’t grant access to this repository’s room.
        </div>
      ) : null}

      {others.length > 0 ? (
        <div className="chat-presence">
          {others.map((u) => (
            <button
              key={u.id}
              className="chat-presence-item"
              title={`${u.name} is viewing ${u.viewing}`}
              onClick={() => u.viewing && void navigateAbsolute(u.viewing, true)}
            >
              {u.avatarUrl ? <img className="chat-avatar" src={u.avatarUrl} alt="" /> : null}
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
