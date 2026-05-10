import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { MarkdownProse } from './MarkdownProse'
import type { ChatMessage, ChatMessagePart } from '../store'

interface DiagramEditMetadata {
  kind: 'created' | 'replaced'
  file: string
  before: string | null
  after: string
}

function isDiagramEditMetadata(value: unknown): value is DiagramEditMetadata {
  if (!value || typeof value !== 'object') return false
  const m = value as Record<string, unknown>
  return (
    (m.kind === 'created' || m.kind === 'replaced') &&
    typeof m.file === 'string' &&
    typeof m.after === 'string'
  )
}

function StatusBadge(): React.JSX.Element {
  const { state } = useStore()
  const { chatStatus, chatError } = state
  const label =
    chatStatus === 'idle'
      ? 'idle'
      : chatStatus === 'connecting'
        ? 'starting opencode…'
        : chatStatus === 'ready'
          ? 'ready'
          : chatStatus === 'thinking'
            ? 'thinking…'
            : 'error'
  return (
    <div className={`chat-status chat-status-${chatStatus}`} title={chatError ?? undefined}>
      <span className="chat-status-dot" />
      {label}
    </div>
  )
}

function PartView({
  part,
  role
}: {
  part: ChatMessagePart
  role: 'user' | 'assistant'
}): React.JSX.Element {
  const { navigateAbsolute } = useStore()
  if (part.kind === 'text') {
    if (role === 'assistant') {
      return (
        <div className="chat-text chat-text-md">
          <MarkdownProse
            source={part.text ?? ''}
            onNavigate={(target) => void navigateAbsolute(target, true)}
          />
        </div>
      )
    }
    return <div className="chat-text">{part.text}</div>
  }
  if (part.kind === 'tool' && part.tool === 'diagram_edit') {
    const meta = isDiagramEditMetadata(part.metadata) ? part.metadata : null
    return (
      <div className="chat-tool chat-tool-diagram">
        <div className="chat-tool-row">
          <span className="chat-tool-name">diagram_edit</span>
          <span className={`chat-tool-status chat-tool-status-${part.status ?? 'running'}`}>
            {part.status ?? 'running'}
          </span>
        </div>
        {meta ? (
          <button
            className="chat-tool-link"
            onClick={() => void navigateAbsolute(meta.file, true)}
            title={`Open ${meta.file}`}
          >
            {meta.kind === 'created' ? '＋ created' : '✎ replaced'} {meta.file}
          </button>
        ) : null}
      </div>
    )
  }
  if (part.kind === 'tool') {
    return (
      <div className="chat-tool">
        <div className="chat-tool-row">
          <span className="chat-tool-name">{part.tool ?? 'tool'}</span>
          <span className={`chat-tool-status chat-tool-status-${part.status ?? 'running'}`}>
            {part.status ?? 'running'}
          </span>
        </div>
      </div>
    )
  }
  return <div className="chat-text chat-text-muted">[unsupported part]</div>
}

function NoProviderHelp(): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const cmd = 'opencode auth login'
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(cmd)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // ignore — user can select+copy manually
    }
  }
  return (
    <div className="chat-help">
      <div className="chat-help-title">No AI provider configured</div>
      <p>Run this in a terminal to set one up, then come back and try again:</p>
      <div className="chat-help-cmd">
        <code>{cmd}</code>
        <button className="secondary" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="chat-help-note">
        opencode supports Anthropic, OpenAI, OpenRouter, GitHub Copilot, and others. Pick one.
      </p>
    </div>
  )
}

function MessageView({ message }: { message: ChatMessage }): React.JSX.Element {
  return (
    <div className={`chat-message chat-message-${message.role}`}>
      <div className="chat-message-role">{message.role === 'user' ? 'You' : 'Agent'}</div>
      <div className="chat-message-body">
        {message.parts.map((part, i) => (
          <PartView key={part.id ?? i} part={part} role={message.role} />
        ))}
      </div>
    </div>
  )
}

export function ChatPanel(): React.JSX.Element {
  const { state, sendChat, toggleChatPanel } = useStore()
  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement | null>(null)
  const sending = state.chatStatus === 'thinking' || state.chatStatus === 'connecting'

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [state.chatMessages.length, state.chatStatus])

  if (!state.chatPanelOpen) {
    return (
      <button
        className="chat-panel-collapsed"
        onClick={toggleChatPanel}
        title="Show chat"
        aria-label="Show chat"
      >
        💬
      </button>
    )
  }

  const send = (): void => {
    const text = input.trim()
    if (!text || sending) return
    setInput('')
    void sendChat(text)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      send()
    }
  }

  return (
    <aside className="chat-panel">
      <div className="chat-header">
        <span className="chat-title">Agent</span>
        <StatusBadge />
        <button
          className="icon-btn"
          onClick={toggleChatPanel}
          title="Hide chat"
          aria-label="Hide chat"
        >
          ✕
        </button>
      </div>
      <div className="chat-list" ref={listRef}>
        {state.chatMessages.length === 0 ? (
          <div className="chat-empty">
            {state.rootPath
              ? 'Describe a feature, change, or question. The agent will edit diagrams first, then code.'
              : 'Open a folder to start chatting with the agent.'}
          </div>
        ) : (
          state.chatMessages.map((m) => <MessageView key={m.id} message={m} />)
        )}
        {sending ? (
          <div className="chat-message chat-message-assistant chat-message-pending">
            <div className="chat-message-role">Agent</div>
            <div className="chat-message-body chat-text-muted">
              {state.chatStatus === 'connecting' ? 'starting opencode…' : 'thinking…'}
            </div>
          </div>
        ) : null}
        {state.chatStatus === 'error' && state.chatError ? (
          state.chatError.startsWith('No AI provider') ? (
            <NoProviderHelp />
          ) : (
            <div className="chat-message chat-message-error">
              <div className="chat-message-role">Error</div>
              <div className="chat-message-body">{state.chatError}</div>
            </div>
          )
        ) : null}
      </div>
      <div className="chat-input-row">
        <textarea
          className="chat-input"
          placeholder={
            state.rootPath ? 'Ask the agent…  (⌘+Enter to send)' : 'Open a folder first'
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={!state.rootPath || sending}
          rows={3}
        />
        <button
          className="primary chat-send-btn"
          onClick={send}
          disabled={!state.rootPath || sending || !input.trim()}
        >
          Send
        </button>
      </div>
    </aside>
  )
}
