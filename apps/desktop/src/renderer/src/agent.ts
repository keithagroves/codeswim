// Thin session-aware wrapper over @opencode-ai/sdk's client.
//
// `connectAgent` doesn't create a session — it just opens the SDK client and
// exposes session primitives (list/create/load/send). The renderer decides
// which session is active. This lets us load past sessions for a workspace
// and switch between them.

import { createOpencodeClient } from '@opencode-ai/sdk/client'

export interface AssistantPart {
  id: string
  kind: 'text' | 'tool' | 'reasoning' | 'unknown'
  text?: string
  tool?: string
  status?: 'running' | 'completed' | 'error'
  metadata?: unknown
  // Tool parts only, and only for the tools a build checkpoint reads (see
  // CHECKPOINT_TOOLS): what the tool was called with, and opencode's title.
  input?: Record<string, unknown>
  title?: string
  // Same tools only: the start of the tool's output. A tool can finish
  // "completed" yet report a failure in its output (diagram_edit returns
  // "error: …" for an invalid diagram), and the checkpoint must tell them apart.
  output?: string
}

// Tools whose input the whiteboard needs: for a build checkpoint, which
// diagrams changed (and to what) and which files the edit tools touched; for
// research, which files `read` opened. Other tools' inputs (`bash`, `grep`)
// stay out of renderer state.
const CHECKPOINT_TOOLS = new Set([
  'diagram_edit',
  'write',
  'edit',
  'apply_patch',
  'multiedit',
  'read'
])

// opencode's per-file diff for a session or one of its turns. opencode 1.18
// sends a unified `patch` (plus `status`); the SDK's types still describe the
// older before/after shape, so both are optional and callers handle either.
export interface FileDiff {
  file: string
  patch?: string
  status?: string
  before?: string
  after?: string
  additions: number
  deletions: number
}

// Session lifecycle events the chat itself doesn't need but a build
// checkpoint does: when a turn finished (`idle`), what it changed, and which
// files the agent touched.
export type SessionEvent =
  | { type: 'idle'; sessionID: string }
  | { type: 'diff'; sessionID: string; diff: FileDiff[] }
  | { type: 'file-edited'; file: string }
  | { type: 'error'; sessionID?: string; message: string }

export interface PartUpdate {
  sessionID: string
  messageID: string
  part: AssistantPart
}

export interface SessionInfo {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface LoadedMessage {
  id: string
  role: 'user' | 'assistant'
  parts: AssistantPart[]
  /** When opencode created it (ms). */
  createdAt?: number
}

/**
 * Title prefix for sessions the app runs behind the scenes (the whiteboard's
 * read-only research). They never show in the session list.
 */
export const HIDDEN_SESSION_PREFIX = 'codeswim:'

export interface AgentSendResult {
  messageID: string
  parts: AssistantPart[]
}

export interface QuestionOption {
  label: string
  description: string
}

export interface QuestionInfo {
  question: string
  header: string
  options: QuestionOption[]
  multiple?: boolean
  custom?: boolean
}

export interface PendingQuestion {
  id: string
  sessionID: string
  questions: QuestionInfo[]
  // Lets us correlate the question with a tool part in the chat so future
  // versions can render the prompt inline next to the agent's "thinking".
  toolCallID?: string
  toolMessageID?: string
}

export type QuestionEvent =
  | { kind: 'asked'; question: PendingQuestion }
  | { kind: 'closed'; sessionID: string; requestID: string }

export interface AgentClient {
  // `directory` overrides the connection's default (rootPath) for a single
  // call — used to run a session against a Kanban "Run all" git worktree
  // instead of the main workspace. The underlying opencode server is
  // directory-aware per request, so one connection can drive sessions across
  // several directories at once.
  listSessions(directory?: string): Promise<SessionInfo[]>
  // `title` presets the session's title, which also skips opencode's
  // auto-titling request for hidden sessions.
  createSession(directory?: string, title?: string): Promise<SessionInfo>
  deleteSession(sessionId: string, directory?: string): Promise<void>
  loadMessages(sessionId: string, directory?: string): Promise<LoadedMessage[]>
  // `model` pins the request to a specific provider/model pair (see
  // SelectedModel below); omitted, opencode falls back to its own default.
  send(
    sessionId: string,
    text: string,
    directory?: string,
    model?: SelectedModel,
    agent?: string,
    // Restricts the tools for this one message, e.g. {"*": false, read: true}
    // for a read-only look (opencode enforces it: other tools aren't offered).
    tools?: Record<string, boolean>
  ): Promise<AgentSendResult>
  // Cancels the in-flight turn on the server. The pending send()'s promise
  // still settles on its own (either with whatever partial reply the server
  // hands back, or with an abort-shaped error) — this only requests the stop.
  stop(sessionId: string, directory?: string): Promise<void>
  subscribeParts(handler: (update: PartUpdate) => void): () => void
  subscribeSessionEvents(handler: (event: SessionEvent) => void): () => void
  // The files a session changed, or with `messageID` just that user turn's
  // changes (opencode's per-message summary).
  sessionDiff(sessionId: string, messageID?: string, directory?: string): Promise<FileDiff[]>
  subscribeQuestions(handler: (event: QuestionEvent) => void): () => void
  listPendingQuestions(sessionId?: string): Promise<PendingQuestion[]>
  replyToQuestion(requestID: string, answers: string[][]): Promise<void>
  rejectQuestion(requestID: string): Promise<void>
  close(): Promise<void>
}

export interface RawPart {
  id: string
  sessionID: string
  messageID: string
  type: string
  text?: string
  tool?: string
  state?: { status?: string; metadata?: unknown; input?: unknown; title?: string; output?: unknown }
  metadata?: unknown
  synthetic?: boolean
  ignored?: boolean
}

interface RawEvent {
  type: string
  properties?: { part?: RawPart; delta?: string }
}

// Pulls a readable message out of opencode's error union (ProviderAuthError,
// ApiError, …: { name, data: { message } }).
function errorMessage(error: unknown): string {
  const e = error as { name?: string; data?: { message?: string } } | undefined
  return e?.data?.message || e?.name || 'The agent reported an error.'
}

// /global/event wraps each Event in an envelope. We unwrap once on receipt.
interface GlobalEventEnvelope {
  directory: string
  payload: RawEvent
}

interface RawSession {
  id: string
  title?: string
  time?: { created?: number; updated?: number }
}

interface RawMessage {
  info: { id: string; role: 'user' | 'assistant'; time?: { created?: number } }
  parts: RawPart[]
}

interface RawQuestionOption {
  label?: string
  description?: string
}

interface RawQuestionInfo {
  question?: string
  header?: string
  options?: RawQuestionOption[]
  multiple?: boolean
  custom?: boolean
}

interface RawQuestionRequest {
  id?: string
  sessionID?: string
  questions?: RawQuestionInfo[]
  tool?: { messageID?: string; callID?: string }
}

function toPendingQuestion(raw: RawQuestionRequest | undefined): PendingQuestion | null {
  if (!raw?.id || !raw.sessionID || !Array.isArray(raw.questions)) return null
  const questions: QuestionInfo[] = raw.questions.map((q) => ({
    question: q.question ?? '',
    header: q.header ?? '',
    options: (q.options ?? []).map((o) => ({
      label: o.label ?? '',
      description: o.description ?? ''
    })),
    multiple: q.multiple ?? false,
    custom: q.custom ?? false
  }))
  return {
    id: raw.id,
    sessionID: raw.sessionID,
    questions,
    toolCallID: raw.tool?.callID,
    toolMessageID: raw.tool?.messageID
  }
}

export class NoProviderError extends Error {
  constructor() {
    super('No AI provider is configured.')
    this.name = 'NoProviderError'
  }
}

export type AuthMethodType = 'oauth' | 'api'

export interface AuthMethod {
  type: AuthMethodType
  label: string
}

export interface ProviderAuthMap {
  [providerId: string]: AuthMethod[]
}

export async function getProviderAuthMethods(
  url: string,
  directory: string
): Promise<ProviderAuthMap> {
  const client = createOpencodeClient({ baseUrl: url, directory })
  const result = await client.provider.auth({ query: { directory }, throwOnError: true })
  return result.data as ProviderAuthMap
}

export async function setApiKey(
  url: string,
  directory: string,
  provider: string,
  key: string
): Promise<void> {
  const client = createOpencodeClient({ baseUrl: url, directory })
  await client.auth.set({
    path: { id: provider },
    body: { type: 'api', key },
    throwOnError: true
  })
}

// A provider/model pair a chat send is pinned to. Distinct from AuthMethod
// above — that's about *which providers have credentials*, this is about
// *which already-configured model to use*.
export interface SelectedModel {
  providerID: string
  modelID: string
}

export interface ConfiguredModel {
  id: string
  name: string
}

export interface ConfiguredProvider {
  id: string
  name: string
  models: ConfiguredModel[]
}

export interface ConfiguredProviders {
  providers: ConfiguredProvider[]
  // providerID → modelID, opencode's own default pick per provider.
  defaults: Record<string, string>
}

interface RawModel {
  id: string
  name?: string
}

interface RawProvider {
  id: string
  name?: string
  models?: Record<string, RawModel>
}

// Lists providers opencode already has credentials for (client.config.providers
// only returns providers it can actually use — same endpoint connectAgent uses
// to detect "no provider configured"), along with each provider's available
// models. This is what backs the model-switcher dropdown: no API key prompt,
// because these providers are already authenticated.
export async function getConfiguredProviders(
  url: string,
  directory: string
): Promise<ConfiguredProviders> {
  const client = createOpencodeClient({ baseUrl: url, directory })
  const result = await client.config.providers({ query: { directory }, throwOnError: true })
  const data = result.data as { providers?: RawProvider[]; default?: Record<string, string> }
  const providers = (data.providers ?? [])
    .map((p) => ({
      id: p.id,
      name: p.name?.trim() || p.id,
      models: Object.values(p.models ?? {})
        .map((m) => ({ id: m.id, name: m.name?.trim() || m.id }))
        .sort((a, b) => a.name.localeCompare(b.name))
    }))
    .filter((p) => p.models.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name))
  return { providers, defaults: data.default ?? {} }
}

export async function connectAgent(url: string, defaultDirectory: string): Promise<AgentClient> {
  const client = createOpencodeClient({ baseUrl: url, directory: defaultDirectory })

  const providers = await client.config.providers({ throwOnError: true })
  const list = (providers.data as { providers?: Array<{ id?: string }> })?.providers ?? []
  if (list.length === 0) throw new NoProviderError()

  const abort = new AbortController()

  // Lazy SSE subscription to opencode's /global/event stream. Each entry is a
  // GlobalEventEnvelope { directory, payload } — we forward only assistant
  // parts so the chat shows incremental progress (text, tool calls, reasoning)
  // without duplicating the user's own prompt back to them. opencode emits a
  // `message.part.updated` for the user's text part too (it's the prompt body)
  // and without role-filtering our reducer would render it as a second
  // assistant bubble.
  const handlers = new Set<(update: PartUpdate) => void>()
  const sessionHandlers = new Set<(event: SessionEvent) => void>()
  const questionHandlers = new Set<(event: QuestionEvent) => void>()
  // messageID → role, learned from `message.updated` events that always
  // precede the corresponding `message.part.updated` events.
  const messageRole = new Map<string, 'user' | 'assistant'>()
  let streamStarted = false
  const startStream = (): void => {
    if (streamStarted) return
    streamStarted = true
    void (async () => {
      try {
        const { stream } = await client.global.event({ signal: abort.signal })
        for await (const envelope of stream) {
          if (abort.signal.aborted) break
          const wrapped = envelope as GlobalEventEnvelope | RawEvent
          const e: RawEvent = (wrapped as GlobalEventEnvelope).payload ?? (wrapped as RawEvent)
          if (e.type === 'message.updated') {
            const info = (e.properties as { info?: { id?: string; role?: string } } | undefined)
              ?.info
            if (info?.id && (info.role === 'user' || info.role === 'assistant')) {
              messageRole.set(info.id, info.role)
            }
            continue
          }
          if (
            e.type === 'session.idle' ||
            e.type === 'session.diff' ||
            e.type === 'file.edited' ||
            e.type === 'session.error'
          ) {
            const event = toSessionEvent(e)
            if (event) for (const h of sessionHandlers) h(event)
            continue
          }
          if (e.type === 'question.asked') {
            const q = toPendingQuestion(e.properties as RawQuestionRequest | undefined)
            if (q) for (const h of questionHandlers) h({ kind: 'asked', question: q })
            continue
          }
          if (e.type === 'question.replied' || e.type === 'question.rejected') {
            const props = e.properties as { sessionID?: string; requestID?: string } | undefined
            if (props?.sessionID && props?.requestID) {
              for (const h of questionHandlers) {
                h({ kind: 'closed', sessionID: props.sessionID, requestID: props.requestID })
              }
            }
            continue
          }
          if (e.type !== 'message.part.updated') continue
          const raw = e.properties?.part
          if (!raw) continue
          // Drop parts belonging to the user's prompt message — those are
          // the user's text echoed back, not the agent's reply.
          if (messageRole.get(raw.messageID) === 'user') continue
          const converted = toAssistantPart(raw)
          if (!converted) continue
          for (const h of handlers) {
            h({ sessionID: raw.sessionID, messageID: raw.messageID, part: converted })
          }
        }
      } catch (err) {
        if (!abort.signal.aborted) {
          // eslint-disable-next-line no-console
          console.error('[codeswim] SSE event stream failed:', err)
        }
      }
    })()
  }

  return {
    async listSessions(directory = defaultDirectory): Promise<SessionInfo[]> {
      const result = await client.session.list({
        query: { directory },
        throwOnError: true,
        signal: abort.signal
      })
      const sessions = (result.data ?? []) as RawSession[]
      return sessions
        .map(toSessionInfo)
        .filter((s) => !s.title.startsWith(HIDDEN_SESSION_PREFIX))
        .sort((a, b) => b.updatedAt - a.updatedAt)
    },

    async createSession(directory = defaultDirectory, title?: string): Promise<SessionInfo> {
      const result = await client.session.create({
        query: { directory },
        ...(title ? { body: { title } } : {}),
        throwOnError: true,
        signal: abort.signal
      })
      return toSessionInfo(result.data as RawSession)
    },

    async deleteSession(sessionId: string, directory = defaultDirectory): Promise<void> {
      await client.session.delete({
        path: { id: sessionId },
        query: { directory },
        throwOnError: true,
        signal: abort.signal
      })
    },

    async loadMessages(sessionId: string, directory = defaultDirectory): Promise<LoadedMessage[]> {
      const result = await client.session.messages({
        path: { id: sessionId },
        query: { directory },
        throwOnError: true,
        signal: abort.signal
      })
      const messages = (result.data ?? []) as RawMessage[]
      return messages.map((m) => ({
        id: m.info.id,
        role: m.info.role,
        parts: m.parts.map(toAssistantPart).filter((p): p is AssistantPart => p !== null),
        ...(typeof m.info.time?.created === 'number' ? { createdAt: m.info.time.created } : {})
      }))
    },

    async send(
      sessionId: string,
      text: string,
      directory = defaultDirectory,
      model?: SelectedModel,
      agent?: string,
      tools?: Record<string, boolean>
    ): Promise<AgentSendResult> {
      const result = await client.session.prompt({
        path: { id: sessionId },
        query: { directory },
        body: {
          parts: [{ type: 'text', text }] as never,
          ...(model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
          ...(agent ? { agent } : {}),
          ...(tools ? { tools } : {})
        },
        throwOnError: true,
        signal: abort.signal
      })
      const data = result.data as { info: { id: string }; parts: RawPart[] }
      return {
        messageID: data.info.id,
        parts: data.parts.map(toAssistantPart).filter((p): p is AssistantPart => p !== null)
      }
    },

    async stop(sessionId: string, directory = defaultDirectory): Promise<void> {
      await client.session.abort({
        path: { id: sessionId },
        query: { directory },
        throwOnError: true,
        signal: abort.signal
      })
    },

    subscribeParts(handler: (update: PartUpdate) => void): () => void {
      handlers.add(handler)
      startStream()
      return () => {
        handlers.delete(handler)
      }
    },

    subscribeSessionEvents(handler: (event: SessionEvent) => void): () => void {
      sessionHandlers.add(handler)
      startStream()
      return () => {
        sessionHandlers.delete(handler)
      }
    },

    async sessionDiff(
      sessionId: string,
      messageID?: string,
      directory = defaultDirectory
    ): Promise<FileDiff[]> {
      const result = await client.session.diff({
        path: { id: sessionId },
        query: { directory, ...(messageID ? { messageID } : {}) },
        throwOnError: true,
        signal: abort.signal
      })
      return ((result.data ?? []) as FileDiff[]).filter((d) => d && typeof d.file === 'string')
    },

    subscribeQuestions(handler: (event: QuestionEvent) => void): () => void {
      questionHandlers.add(handler)
      startStream()
      return () => {
        questionHandlers.delete(handler)
      }
    },

    async listPendingQuestions(sessionId?: string): Promise<PendingQuestion[]> {
      // v1 SDK doesn't surface /question as a named method — hit it raw.
      const params = new URLSearchParams({ directory: defaultDirectory })
      const res = await fetch(`${url}/question?${params}`, { signal: abort.signal })
      if (!res.ok) {
        throw new Error(`GET /question → ${res.status} ${res.statusText}`)
      }
      const data = (await res.json()) as RawQuestionRequest[]
      return data
        .map(toPendingQuestion)
        .filter((q): q is PendingQuestion => q !== null)
        .filter((q) => !sessionId || q.sessionID === sessionId)
    },

    async replyToQuestion(requestID: string, answers: string[][]): Promise<void> {
      const params = new URLSearchParams({ directory: defaultDirectory })
      const res = await fetch(`${url}/question/${encodeURIComponent(requestID)}/reply?${params}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers }),
        signal: abort.signal
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(
          `POST /question/${requestID}/reply → ${res.status} ${res.statusText} ${detail}`
        )
      }
    },

    async rejectQuestion(requestID: string): Promise<void> {
      const params = new URLSearchParams({ directory: defaultDirectory })
      const res = await fetch(`${url}/question/${encodeURIComponent(requestID)}/reject?${params}`, {
        method: 'POST',
        signal: abort.signal
      })
      if (!res.ok) {
        throw new Error(`POST /question/${requestID}/reject → ${res.status} ${res.statusText}`)
      }
    },

    async close(): Promise<void> {
      abort.abort()
      handlers.clear()
      sessionHandlers.clear()
      questionHandlers.clear()
    }
  }
}

function toSessionInfo(s: RawSession): SessionInfo {
  const created = s.time?.created ?? Date.now()
  const updated = s.time?.updated ?? created
  return {
    id: s.id,
    title: s.title?.trim() || `Session ${s.id.slice(-6)}`,
    createdAt: created,
    updatedAt: updated
  }
}

export function toAssistantPart(p: RawPart): AssistantPart | null {
  if (p.synthetic || p.ignored) return null
  if (p.type === 'text') {
    return { id: p.id, kind: 'text', text: p.text ?? '' }
  }
  if (p.type === 'reasoning') {
    return { id: p.id, kind: 'reasoning', text: p.text ?? '' }
  }
  if (p.type === 'tool') {
    const keepInput =
      !!p.tool &&
      CHECKPOINT_TOOLS.has(p.tool) &&
      p.state?.input &&
      typeof p.state.input === 'object'
    return {
      id: p.id,
      kind: 'tool',
      tool: p.tool,
      status: (p.state?.status as AssistantPart['status']) ?? 'running',
      metadata: p.state?.metadata,
      ...(keepInput ? { input: p.state!.input as Record<string, unknown> } : {}),
      ...(keepInput && typeof p.state?.output === 'string'
        ? { output: p.state.output.slice(0, 500) }
        : {}),
      ...(p.state?.title ? { title: p.state.title } : {})
    }
  }
  // step-start, step-finish, snapshot, etc. — not user-facing.
  return null
}

export function toSessionEvent(e: { type: string; properties?: unknown }): SessionEvent | null {
  const props = (e.properties ?? {}) as {
    sessionID?: string
    diff?: unknown
    file?: string
    error?: unknown
  }
  switch (e.type) {
    case 'session.idle':
      return props.sessionID ? { type: 'idle', sessionID: props.sessionID } : null
    case 'session.diff':
      return props.sessionID && Array.isArray(props.diff)
        ? { type: 'diff', sessionID: props.sessionID, diff: props.diff as FileDiff[] }
        : null
    case 'file.edited':
      return props.file ? { type: 'file-edited', file: props.file } : null
    case 'session.error':
      return { type: 'error', sessionID: props.sessionID, message: errorMessage(props.error) }
    default:
      return null
  }
}
