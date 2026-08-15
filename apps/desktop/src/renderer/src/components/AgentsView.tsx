import { useEffect, useMemo, useRef, useState } from 'react'
import { flattenTreeFiles, useStore } from '../store'
import { resolveWorkspacePath } from '../path-utils'
import { MessageView, QuestionPrompt } from './ChatPanel'
import type { AgentTab } from '../store'

// The Agents workspace view: browser-style tabs across the top, one agent
// (opencode session) per tab. Tabs run independently — a send in one tab
// doesn't block typing or streaming in another.

function statusTitle(tab: AgentTab): string {
  if (tab.status === 'error') return tab.error ?? 'error'
  if (tab.status === 'thinking') return 'thinking…'
  if (tab.status === 'connecting') return 'starting…'
  return tab.title
}

function TabStrip(): React.JSX.Element {
  const { state, openAgentTab, closeAgentTab, activateAgentTab } = useStore()
  return (
    <div className="agents-tabbar" role="tablist" aria-label="Agents">
      {state.agentTabs.map((tab) => {
        const active = tab.id === state.activeAgentTabId
        return (
          <div
            key={tab.id}
            className={`agents-tab ${active ? 'is-active' : ''}`}
            role="tab"
            aria-selected={active}
            title={statusTitle(tab)}
            onClick={() => activateAgentTab(tab.id)}
          >
            <span className={`agents-tab-dot agents-tab-dot-${tab.status}`} />
            <span className="agents-tab-title">{tab.title}</span>
            <button
              className="agents-tab-close"
              aria-label={`Close ${tab.title}`}
              title="Close tab"
              onClick={(e) => {
                e.stopPropagation()
                closeAgentTab(tab.id)
              }}
            >
              ×
            </button>
          </div>
        )
      })}
      <button
        className="agents-tab-new"
        onClick={() => openAgentTab()}
        title="New agent"
        aria-label="New agent"
      >
        +
      </button>
    </div>
  )
}

function AgentTabBody({ tab }: { tab: AgentTab }): React.JSX.Element {
  const { state, sendAgentChat } = useStore()
  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement | null>(null)
  const sending = tab.status === 'thinking' || tab.status === 'connecting'
  const hasPendingQuestion = !!tab.pendingQuestion

  const resolvePath = useMemo(() => {
    const files = flattenTreeFiles(state.tree)
    return (raw: string) => resolveWorkspacePath(raw, files)
  }, [state.tree])

  const lastMessage = tab.messages[tab.messages.length - 1]
  const hasStreamingAssistant =
    sending && lastMessage?.role === 'assistant' && lastMessage.parts.length > 0

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [tab.messages, tab.status])

  const send = (): void => {
    const text = input.trim()
    if (!text || sending) return
    setInput('')
    void sendAgentChat(tab.id, text)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key !== 'Enter') return
    if (e.shiftKey || e.nativeEvent.isComposing) return
    e.preventDefault()
    send()
  }

  return (
    <div className="agents-tab-body">
      <div className="chat-list" ref={listRef}>
        {tab.messages.length === 0 ? (
          <div className="chat-empty">
            Each tab is its own agent with a fresh session. Ask away — other tabs keep working in
            the background.
          </div>
        ) : (
          tab.messages.map((m) => <MessageView key={m.id} message={m} resolvePath={resolvePath} />)
        )}
        {sending && !hasStreamingAssistant ? (
          <div className="chat-message chat-message-assistant chat-message-pending">
            <div className="chat-message-role">Agent</div>
            <div className="chat-message-body chat-text-muted">
              {tab.status === 'connecting' ? 'starting…' : 'thinking…'}
            </div>
          </div>
        ) : null}
        {tab.status === 'error' && tab.error ? (
          <div className="chat-message chat-message-error">
            <div className="chat-message-role">Error</div>
            <div className="chat-message-body chat-error-body">{tab.error}</div>
          </div>
        ) : null}
      </div>
      <QuestionPrompt pending={tab.pendingQuestion} />
      <div className="chat-input-row">
        <textarea
          className="chat-input"
          placeholder={
            hasPendingQuestion
              ? 'Answer the agent above to continue'
              : 'Ask this agent…  (Enter to send, Shift+Enter for newline)'
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={sending || hasPendingQuestion}
          rows={3}
        />
        <button
          className="primary chat-send-btn"
          onClick={send}
          disabled={sending || hasPendingQuestion || !input.trim()}
        >
          Send
        </button>
      </div>
    </div>
  )
}

export function AgentsView(): React.JSX.Element {
  const { state, openAgentTab } = useStore()
  const active = state.agentTabs.find((t) => t.id === state.activeAgentTabId) ?? null

  return (
    <div className="agents-view">
      <TabStrip />
      {active ? (
        // Keyed so per-tab input drafts and scroll reset when switching tabs
        // instead of leaking between agents.
        <AgentTabBody key={active.id} tab={active} />
      ) : (
        <div className="agents-empty">
          <p>Run several agents side by side, each in its own tab.</p>
          <button className="primary" onClick={() => openAgentTab()}>
            + New agent
          </button>
        </div>
      )}
    </div>
  )
}
