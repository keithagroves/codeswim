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
  if (part.kind === 'reasoning') {
    return (
      <div className="chat-reasoning">
        <div className="chat-reasoning-label">Thinking</div>
        <div className="chat-reasoning-body">{part.text}</div>
      </div>
    )
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

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  google: 'Google AI',
  groq: 'Groq',
  xai: 'xAI',
  mistral: 'Mistral',
  cerebras: 'Cerebras',
  deepseek: 'DeepSeek',
  fireworks: 'Fireworks',
  ollama: 'Ollama',
  vertex: 'Google Vertex',
  bedrock: 'AWS Bedrock',
  azure: 'Azure',
  'github-copilot': 'GitHub Copilot'
}

// Providers that accept a plain API key via `auth.set`, even when opencode
// doesn't list them in /provider/auth (which only returns providers with
// custom auth-hook plugins). We add these so users can paste an API key for
// the common big-name providers without leaving the app.
const COMMON_API_KEY_PROVIDERS = [
  'anthropic',
  'openai',
  'openrouter',
  'google',
  'groq',
  'xai',
  'mistral',
  'cerebras',
  'deepseek',
  'fireworks'
]

function prettyProvider(id: string): string {
  return PROVIDER_LABELS[id] ?? id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

interface ProviderOption {
  id: string
  label: string
  hasApi: boolean
  hasOauth: boolean
}

function ProviderSetup({ onCancel }: { onCancel?: () => void } = {}): React.JSX.Element {
  const { fetchProviderMethods, configureProvider } = useStore()
  const [methods, setMethods] = useState<ProviderOption[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [providerId, setProviderId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const raw = await fetchProviderMethods()
        if (cancelled) return
        const opts = new Map<string, ProviderOption>()
        for (const [id, list] of Object.entries(raw)) {
          opts.set(id, {
            id,
            label: prettyProvider(id),
            hasApi: list.some((m) => m.type === 'api'),
            hasOauth: list.some((m) => m.type === 'oauth')
          })
        }
        // Augment with common API-key providers that aren't in /provider/auth.
        for (const id of COMMON_API_KEY_PROVIDERS) {
          if (opts.has(id)) continue
          opts.set(id, { id, label: prettyProvider(id), hasApi: true, hasOauth: false })
        }
        const sorted = [...opts.values()]
          .filter((o) => o.hasApi || o.hasOauth)
          .sort((a, b) => a.label.localeCompare(b.label))
        setMethods(sorted)
        const preferred =
          sorted.find((o) => o.id === 'anthropic') ??
          sorted.find((o) => o.id === 'openai') ??
          sorted.find((o) => o.hasApi)
        if (preferred) setProviderId(preferred.id)
      } catch (err) {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : String(err)
        setLoadError(msg)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [fetchProviderMethods])

  const selected = methods?.find((o) => o.id === providerId) ?? null
  const canSave = selected?.hasApi === true && apiKey.trim().length > 0 && !saving

  const onSave = async (): Promise<void> => {
    if (!selected || !canSave) return
    setSaving(true)
    setSaveError(null)
    try {
      await configureProvider(selected.id, apiKey.trim())
      // chat-status flips to 'ready' inside configureProvider via ensureAgent;
      // this component will unmount when chatStatus !== 'error'.
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setSaveError(msg)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="chat-help">
      <div className="chat-help-title">Configure an AI provider</div>
      {loadError ? (
        <p className="chat-help-error">Couldn’t load providers: {loadError}</p>
      ) : methods === null ? (
        <p className="chat-help-note">Loading providers…</p>
      ) : (
        <>
          <p>Pick a provider and paste an API key. The key is sent only to the local opencode server.</p>
          <label className="chat-help-label">
            Provider
            <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
              {methods.map((opt) => (
                <option key={opt.id} value={opt.id} disabled={!opt.hasApi}>
                  {opt.label}
                  {!opt.hasApi && opt.hasOauth ? ' (OAuth — use terminal)' : ''}
                </option>
              ))}
            </select>
          </label>
          {selected?.hasApi ? (
            <label className="chat-help-label">
              API key
              <input
                type="password"
                placeholder="sk-…"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          ) : selected?.hasOauth ? (
            <p className="chat-help-note">
              This provider uses OAuth. Run <code>npx opencode auth login</code> in a terminal to
              complete the browser flow.
            </p>
          ) : null}
          {saveError ? <p className="chat-help-error">{saveError}</p> : null}
          <div className="chat-help-actions">
            {onCancel ? (
              <button className="secondary" onClick={onCancel} disabled={saving}>
                Cancel
              </button>
            ) : null}
            <button
              className="primary"
              onClick={() => void onSave()}
              disabled={!canSave}
            >
              {saving ? 'Saving…' : 'Save and connect'}
            </button>
          </div>
        </>
      )}
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

function truncateTitle(title: string, max = 40): string {
  if (title.length <= max) return title
  return title.slice(0, max - 1) + '…'
}

function SessionBar(): React.JSX.Element | null {
  const { state, newSession, switchSession } = useStore()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  if (!state.rootPath) return null
  const current = state.sessions.find((s) => s.id === state.currentSessionId) ?? null
  const label = current ? truncateTitle(current.title) : 'No session'

  return (
    <div className="chat-session-bar" ref={ref}>
      <button
        className="chat-session-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={current?.title ?? 'Pick a session'}
      >
        <span className="chat-session-label">{label}</span>
        <span className="chat-session-caret">▾</span>
      </button>
      {open ? (
        <div className="chat-session-menu" role="menu">
          <button
            className="chat-session-menu-item chat-session-menu-new"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              void newSession()
            }}
          >
            + New session
          </button>
          <div className="chat-session-menu-divider" />
          {state.sessions.length === 0 ? (
            <div className="chat-session-menu-empty">No sessions yet</div>
          ) : (
            state.sessions.map((s) => (
              <button
                key={s.id}
                className={`chat-session-menu-item ${
                  s.id === state.currentSessionId ? 'is-current' : ''
                }`}
                role="menuitemradio"
                aria-checked={s.id === state.currentSessionId}
                onClick={() => {
                  setOpen(false)
                  if (s.id !== state.currentSessionId) void switchSession(s.id)
                }}
              >
                <span className="chat-session-menu-title">{truncateTitle(s.title, 36)}</span>
                <span className="chat-session-menu-time">
                  {new Date(s.updatedAt).toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit'
                  })}
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}

interface QuestionAnswerDraft {
  selected: string[]
  custom: string
}

function QuestionPrompt(): React.JSX.Element | null {
  const { state, answerQuestion, rejectQuestion } = useStore()
  const pending = state.pendingQuestion
  const requestID = pending?.id
  const questions = pending?.questions ?? []
  const [drafts, setDrafts] = useState<QuestionAnswerDraft[]>([])
  const [submitting, setSubmitting] = useState(false)

  // Reset drafts whenever a new question request comes in.
  useEffect(() => {
    setDrafts(questions.map(() => ({ selected: [], custom: '' })))
    setSubmitting(false)
    // questions array identity changes per-request via pending.id
  }, [requestID, questions.length])

  if (!pending) return null

  const updateDraft = (i: number, next: Partial<QuestionAnswerDraft>): void => {
    setDrafts((prev) => {
      const out = prev.slice()
      out[i] = { ...out[i], ...next }
      return out
    })
  }

  const toggleSelected = (i: number, label: string, multiple: boolean): void => {
    const current = drafts[i]?.selected ?? []
    if (multiple) {
      const next = current.includes(label)
        ? current.filter((l) => l !== label)
        : [...current, label]
      updateDraft(i, { selected: next })
    } else {
      updateDraft(i, { selected: [label] })
    }
  }

  // Whether the textarea is shown: explicit `custom: true`, or implicitly
  // when the question has no clickable options to choose from.
  const allowsCustom = (q: typeof questions[number]): boolean =>
    !!q.custom || q.options.length === 0

  const isReady = drafts.every((d, i) => {
    const q = questions[i]
    if (!q) return false
    if (allowsCustom(q) && d.custom.trim().length > 0) return true
    return d.selected.length > 0
  })

  const onSubmit = async (): Promise<void> => {
    if (!isReady || submitting) return
    setSubmitting(true)
    // opencode expects an answer array per question. We prefer the custom
    // text field when filled; otherwise we hand back the chosen option
    // labels.
    const answers: string[][] = drafts.map((d) => {
      const trimmed = d.custom.trim()
      if (trimmed.length > 0) return [trimmed]
      return d.selected
    })
    await answerQuestion(pending.id, answers)
    setSubmitting(false)
  }

  const onCancel = (): void => {
    if (submitting) return
    void rejectQuestion(pending.id)
  }

  return (
    <div className="chat-question">
      <div className="chat-question-header">
        <span className="chat-question-label">Agent is asking</span>
        <button className="link-btn" onClick={onCancel} disabled={submitting} title="Cancel this question">
          Cancel
        </button>
      </div>
      {questions.map((q, i) => {
        const draft = drafts[i] ?? { selected: [], custom: '' }
        return (
          <div key={i} className="chat-question-block">
            {q.header ? <div className="chat-question-tag">{q.header}</div> : null}
            <div className="chat-question-text">{q.question}</div>
            {q.options.length > 0 ? (
              <div className="chat-question-options">
                {q.options.map((opt) => {
                  const checked = draft.selected.includes(opt.label)
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      className={`chat-question-option ${checked ? 'is-selected' : ''}`}
                      onClick={() => toggleSelected(i, opt.label, !!q.multiple)}
                      disabled={submitting}
                    >
                      <span className="chat-question-option-label">{opt.label}</span>
                      {opt.description ? (
                        <span className="chat-question-option-desc">{opt.description}</span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            ) : null}
            {allowsCustom(q) ? (
              <textarea
                className="chat-question-custom"
                placeholder={
                  q.options.length > 0 ? 'Or type a custom answer…' : 'Type your answer…'
                }
                value={draft.custom}
                onChange={(e) => updateDraft(i, { custom: e.target.value })}
                disabled={submitting}
                rows={2}
              />
            ) : null}
          </div>
        )
      })}
      <div className="chat-question-actions">
        <button
          className="primary"
          onClick={() => void onSubmit()}
          disabled={!isReady || submitting}
        >
          {submitting ? 'Sending…' : 'Send answer'}
        </button>
      </div>
    </div>
  )
}

export function ChatPanel(): React.JSX.Element {
  const { state, sendChat, toggleChatSettings } = useStore()
  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement | null>(null)
  const sending = state.chatStatus === 'thinking' || state.chatStatus === 'connecting'
  const hasPendingQuestion = !!state.pendingQuestion
  const lastMessage = state.chatMessages[state.chatMessages.length - 1]
  const hasStreamingAssistant =
    sending && lastMessage?.role === 'assistant' && lastMessage.parts.length > 0

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [state.chatMessages.length, state.chatStatus])

  const send = (): void => {
    const text = input.trim()
    if (!text || sending) return
    setInput('')
    void sendChat(text)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key !== 'Enter') return
    // Shift+Enter inserts a newline; Enter alone sends. Ignore IME composition
    // so people typing CJK don't accidentally send mid-character.
    if (e.shiftKey || e.nativeEvent.isComposing) return
    e.preventDefault()
    send()
  }

  return (
    <aside className="chat-panel">
      <div className="chat-header">
        <span className="chat-title">Agent</span>
        <StatusBadge />
        <button
          className="icon-btn"
          onClick={toggleChatSettings}
          title="Provider settings"
          aria-label="Provider settings"
          aria-pressed={state.chatSettingsOpen}
          disabled={!state.rootPath}
        >
          ⚙
        </button>
      </div>
      <SessionBar />
      {state.chatSettingsOpen ? (
        // Render settings ABOVE the scrollable list so it stays visible
        // regardless of how far the messages have scrolled.
        <div className="chat-settings-pane">
          <ProviderSetup onCancel={toggleChatSettings} />
        </div>
      ) : null}
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
        {sending && !hasStreamingAssistant ? (
          <div className="chat-message chat-message-assistant chat-message-pending">
            <div className="chat-message-role">Agent</div>
            <div className="chat-message-body chat-text-muted">
              {state.chatStatus === 'connecting' ? 'starting opencode…' : 'thinking…'}
            </div>
          </div>
        ) : null}
        {state.chatStatus === 'error' && state.chatError ? (
          state.chatError.startsWith('No AI provider') ? (
            <ProviderSetup />
          ) : (
            <div className="chat-message chat-message-error">
              <div className="chat-message-role">Error</div>
              <div className="chat-message-body chat-error-body">{state.chatError}</div>
            </div>
          )
        ) : null}
      </div>
      <QuestionPrompt />
      <div className="chat-input-row">
        <textarea
          className="chat-input"
          placeholder={
            hasPendingQuestion
              ? 'Answer the agent above to continue'
              : state.rootPath
                ? 'Ask the agent…  (Enter to send, Shift+Enter for newline)'
                : 'Open a folder first'
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={!state.rootPath || sending || hasPendingQuestion}
          rows={3}
        />
        <button
          className="primary chat-send-btn"
          onClick={send}
          disabled={!state.rootPath || sending || hasPendingQuestion || !input.trim()}
        >
          Send
        </button>
      </div>
    </aside>
  )
}
