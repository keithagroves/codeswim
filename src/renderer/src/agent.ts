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
}

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
}

export interface AgentSendResult {
  messageID: string
  parts: AssistantPart[]
}

export interface AgentClient {
  listSessions(): Promise<SessionInfo[]>
  createSession(): Promise<SessionInfo>
  loadMessages(sessionId: string): Promise<LoadedMessage[]>
  send(sessionId: string, text: string): Promise<AgentSendResult>
  subscribeParts(handler: (update: PartUpdate) => void): () => void
  close(): Promise<void>
}

interface RawPart {
  id: string
  sessionID: string
  messageID: string
  type: string
  text?: string
  tool?: string
  state?: { status?: string; metadata?: unknown }
  metadata?: unknown
  synthetic?: boolean
  ignored?: boolean
}

interface RawEvent {
  type: string
  properties?: { part?: RawPart; delta?: string }
}

interface RawSession {
  id: string
  title?: string
  time?: { created?: number; updated?: number }
}

interface RawMessage {
  info: { id: string; role: 'user' | 'assistant' }
  parts: RawPart[]
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

export async function connectAgent(url: string, directory: string): Promise<AgentClient> {
  const client = createOpencodeClient({ baseUrl: url, directory })

  const providers = await client.config.providers({ throwOnError: true })
  const list = (providers.data as { providers?: Array<{ id?: string }> })?.providers ?? []
  if (list.length === 0) throw new NoProviderError()

  const abort = new AbortController()

  // Lazy SSE subscription to opencode's event stream. We start it on the
  // first subscribeParts() call and forward `message.part.updated` events to
  // any registered handler. This is how the chat panel surfaces incremental
  // progress (text deltas, tool starts/finishes, reasoning) instead of just
  // showing "thinking…" until the final response arrives.
  const handlers = new Set<(update: PartUpdate) => void>()
  let streamStarted = false
  const startStream = (): void => {
    if (streamStarted) return
    streamStarted = true
    void (async () => {
      try {
        const { stream } = await client.event.subscribe({
          query: { directory },
          signal: abort.signal
        })
        for await (const evt of stream) {
          if (abort.signal.aborted) break
          const e = evt as RawEvent
          if (e.type !== 'message.part.updated') continue
          const raw = e.properties?.part
          if (!raw) continue
          const converted = toAssistantPart(raw)
          if (!converted) continue
          for (const h of handlers) {
            h({ sessionID: raw.sessionID, messageID: raw.messageID, part: converted })
          }
        }
      } catch {
        // Stream ends when the agent is closed or the connection drops. The
        // next workspace open spins up a fresh agent + stream.
      }
    })()
  }

  return {
    async listSessions(): Promise<SessionInfo[]> {
      const result = await client.session.list({
        query: { directory },
        throwOnError: true,
        signal: abort.signal
      })
      const sessions = (result.data ?? []) as RawSession[]
      return sessions
        .map(toSessionInfo)
        .sort((a, b) => b.updatedAt - a.updatedAt)
    },

    async createSession(): Promise<SessionInfo> {
      const result = await client.session.create({
        query: { directory },
        throwOnError: true,
        signal: abort.signal
      })
      return toSessionInfo(result.data as RawSession)
    },

    async loadMessages(sessionId: string): Promise<LoadedMessage[]> {
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
        parts: m.parts
          .map(toAssistantPart)
          .filter((p): p is AssistantPart => p !== null)
      }))
    },

    async send(sessionId: string, text: string): Promise<AgentSendResult> {
      const result = await client.session.prompt({
        path: { id: sessionId },
        query: { directory },
        body: { parts: [{ type: 'text', text }] },
        throwOnError: true,
        signal: abort.signal
      })
      const data = result.data as { info: { id: string }; parts: RawPart[] }
      return {
        messageID: data.info.id,
        parts: data.parts
          .map(toAssistantPart)
          .filter((p): p is AssistantPart => p !== null)
      }
    },

    subscribeParts(handler: (update: PartUpdate) => void): () => void {
      handlers.add(handler)
      startStream()
      return () => {
        handlers.delete(handler)
      }
    },

    async close(): Promise<void> {
      abort.abort()
      handlers.clear()
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

function toAssistantPart(p: RawPart): AssistantPart | null {
  if (p.synthetic || p.ignored) return null
  if (p.type === 'text') {
    return { id: p.id, kind: 'text', text: p.text ?? '' }
  }
  if (p.type === 'reasoning') {
    return { id: p.id, kind: 'reasoning', text: p.text ?? '' }
  }
  if (p.type === 'tool') {
    return {
      id: p.id,
      kind: 'tool',
      tool: p.tool,
      status: (p.state?.status as AssistantPart['status']) ?? 'running',
      metadata: p.state?.metadata
    }
  }
  // step-start, step-finish, snapshot, etc. — not user-facing.
  return null
}
