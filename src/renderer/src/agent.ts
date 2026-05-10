// Streaming wrapper over @opencode-ai/sdk's client.
//
// Lifecycle: `connectAgent` creates a session and subscribes to the global
// event stream. `send` fires `promptAsync` and returns immediately; replies
// arrive via `on(handler)` events. `close` aborts the subscription.

import { createOpencodeClient } from '@opencode-ai/sdk/client'

export interface AssistantPart {
  id: string
  kind: 'text' | 'tool' | 'unknown'
  text?: string
  tool?: string
  status?: 'running' | 'completed' | 'error'
  metadata?: unknown
}

export type AgentEvent =
  | { kind: 'part-updated'; messageID: string; part: AssistantPart }
  | { kind: 'session-idle' }
  | { kind: 'session-error'; message: string }

export interface AgentClient {
  sessionId: string
  send(text: string): Promise<void>
  on(handler: (e: AgentEvent) => void): () => void
  close(): Promise<void>
}

interface RawEvent {
  type: string
  properties?: Record<string, unknown>
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
}

export class NoProviderError extends Error {
  constructor() {
    super(
      'No AI provider is configured. Run `opencode auth login` in a terminal, ' +
        'pick a provider, then come back and try again.'
    )
    this.name = 'NoProviderError'
  }
}

export async function connectAgent(url: string, directory: string): Promise<AgentClient> {
  const client = createOpencodeClient({ baseUrl: url, directory })

  const providers = await client.config.providers({ throwOnError: true })
  const list = (providers.data as { providers?: Array<{ id?: string }> })?.providers ?? []
  if (list.length === 0) throw new NoProviderError()

  const created = await client.session.create({
    query: { directory },
    throwOnError: true
  })
  const sessionId = (created.data as { id: string }).id

  const handlers = new Set<(e: AgentEvent) => void>()
  const abort = new AbortController()

  void (async () => {
    try {
      const sse = await client.event.subscribe({
        query: { directory },
        signal: abort.signal
      })
      for await (const raw of sse.stream) {
        const event = raw as RawEvent
        const mapped = mapEvent(event, sessionId)
        if (!mapped) continue
        for (const h of handlers) h(mapped)
      }
    } catch (err) {
      if (abort.signal.aborted) return
      const message = err instanceof Error ? err.message : String(err)
      for (const h of handlers) h({ kind: 'session-error', message })
    }
  })()

  return {
    sessionId,
    async send(text: string): Promise<void> {
      await client.session.promptAsync({
        path: { id: sessionId },
        query: { directory },
        body: {
          parts: [{ type: 'text', text }]
        },
        throwOnError: true
      })
    },
    on(handler) {
      handlers.add(handler)
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

function mapEvent(ev: RawEvent, sessionId: string): AgentEvent | null {
  if (ev.type === 'message.part.updated') {
    const part = (ev.properties as { part?: RawPart })?.part
    if (!part || part.sessionID !== sessionId) return null
    const mapped = toAssistantPart(part)
    if (!mapped) return null
    return { kind: 'part-updated', messageID: part.messageID, part: mapped }
  }
  if (ev.type === 'session.idle') {
    const props = ev.properties as { sessionID?: string } | undefined
    if (props?.sessionID !== sessionId) return null
    return { kind: 'session-idle' }
  }
  if (ev.type === 'session.error') {
    const props = ev.properties as
      | { sessionID?: string; error?: { message?: string } }
      | undefined
    if (props?.sessionID !== sessionId) return null
    return { kind: 'session-error', message: props?.error?.message ?? 'agent error' }
  }
  return null
}

function toAssistantPart(p: RawPart): AssistantPart | null {
  if (p.type === 'text') {
    return { id: p.id, kind: 'text', text: p.text ?? '' }
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
  // step-start, step-finish, snapshot, reasoning, etc. — ignored for now.
  return null
}
