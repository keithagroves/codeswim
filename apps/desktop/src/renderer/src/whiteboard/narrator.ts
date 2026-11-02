// The narrator's transport: hidden sessions on the narrator's own opencode
// server (main/sidecar.ts, startNarratorSidecar).
//
// Every request runs in `directory` — the narrator's empty directory, never
// the workspace — as one of the narrator agents (prompts/index.ts). Sessions
// are created ahead of time, so a question never waits on session.create,
// and deleted when the turn is done with them. Each request carries the whole
// conversation in its text (turn.ts, composePrompt), so a session never needs
// to outlive its turn.
//
// Replies stream: the request goes out with promptAsync, and the reply's
// text arrives as message.part.delta events on the server's event stream,
// handed to the turn a line at a time. Deltas of the model's reasoning are
// skipped: a part announces its type (message.part.updated) before its
// deltas. A model that turns out to be unavailable is skipped for a while and
// the request is retried, in a fresh session, with the next one
// (narrator-models.ts). opencode doesn't fail a request that hits a limit: it
// keeps retrying it quietly, for as long as the limit lasts. So a retry is
// taken as "unavailable" too.

import { createOpencodeClient } from '@opencode-ai/sdk/client'
import {
  NARRATOR_AGENTS,
  NARRATOR_SESSION_TITLE,
  type NarratorConversation,
  type NarratorMode,
  type NarratorTransport
} from '@codeswim/whiteboard'
import { getConfiguredProviders, type ConfiguredProvider, type SelectedModel } from '../agent'
import { isUnavailable, modelKey, streams } from './narrator-models'

const MODES: NarratorMode[] = ['opener', 'main', 'walkthrough']
/** Spare sessions kept ready per mode. */
const POOL_SIZE = 1
/** How long a model that was unavailable is skipped. */
const SKIP_MS = 10 * 60_000

interface RawEvent {
  type?: string
  properties?: {
    sessionID?: string
    info?: { id?: string; role?: string; error?: RawError }
    part?: { id?: string; messageID?: string; type?: string; text?: string; synthetic?: boolean }
    partID?: string
    field?: string
    delta?: string
    error?: RawError
    status?: { type?: string; message?: string }
  }
}

interface RawError {
  name?: string
  data?: { message?: string }
}

interface Listener {
  event(e: RawEvent): void
  fail(error: Error): void
}

interface MessagesReply {
  info?: { role?: string }
  parts?: Array<{ type?: string; text?: string; synthetic?: boolean }>
}

/** Picks the models to try, in order, from what the narrator's server can use. */
export type NarratorModels = (providers: ConfiguredProvider[]) => SelectedModel[]

export class OpencodeNarrator implements NarratorTransport {
  private readonly client: ReturnType<typeof createOpencodeClient>
  private readonly pool: Record<NarratorMode, Promise<string>[]> = {
    opener: [],
    main: [],
    walkthrough: []
  }
  private readonly listeners = new Map<string, Listener>()
  private readonly stop = new AbortController()
  private connected: Promise<void> | null = null
  private providers: ConfiguredProvider[] = []
  private loading: Promise<ConfiguredProvider[]> | null = null
  /** Model key → when to try it again. */
  private readonly unavailable = new Map<string, number>()

  constructor(
    private readonly url: string,
    private readonly directory: string,
    private readonly models: NarratorModels
  ) {
    this.client = createOpencodeClient({ baseUrl: url, directory })
  }

  /** Create the spare sessions and open the event stream now, so the first question is as fast as the rest. */
  warm(): void {
    for (const mode of MODES) this.refill(mode)
    void this.connect().catch(() => {})
    void this.loadProviders().catch(() => {})
  }

  async streams(): Promise<boolean> {
    if (!this.providers.length) await this.loadProviders().catch(() => {})
    return streams(this.candidates()[0])
  }

  async open(mode: NarratorMode): Promise<NarratorConversation> {
    const pending = this.pool[mode].shift()
    this.refill(mode)
    let id: string
    try {
      id = await (pending ?? this.create())
    } catch {
      // A spare made before the server restarted; make a fresh one.
      id = await this.create()
    }
    return {
      send: async (text, signal, onLine) => {
        const reply = await this.send(id, mode, text, signal, onLine)
        id = reply.id
        return reply.text
      },
      close: () => this.remove(id)
    }
  }

  /** Delete the spare sessions and stop listening (the view is going away for good). */
  dispose(): void {
    this.stop.abort()
    for (const mode of MODES) {
      for (const pending of this.pool[mode].splice(0)) {
        void pending.then((id) => this.remove(id)).catch(() => {})
      }
    }
  }

  private candidates(): SelectedModel[] {
    const now = Date.now()
    return this.models(this.providers).filter(
      (m) => (this.unavailable.get(modelKey(m)) ?? 0) <= now
    )
  }

  private loadProviders(): Promise<ConfiguredProvider[]> {
    this.loading ??= getConfiguredProviders(this.url, this.directory)
      .then((r) => (this.providers = r.providers))
      .finally(() => (this.loading = null))
    return this.loading
  }

  private refill(mode: NarratorMode): void {
    while (this.pool[mode].length < POOL_SIZE) {
      const p = this.create()
      p.catch(() => {}) // surfaced when the session is actually used
      this.pool[mode].push(p)
    }
  }

  private async create(): Promise<string> {
    const result = await this.client.session.create({
      query: { directory: this.directory },
      // A preset title also skips opencode's auto-titling request.
      body: { title: NARRATOR_SESSION_TITLE },
      throwOnError: true
    })
    return (result.data as { id: string }).id
  }

  private remove(id: string): void {
    void this.client.session
      .delete({ path: { id }, query: { directory: this.directory } })
      .catch(() => {})
  }

  /** Ask, moving on to the next model while the current one is unavailable. Resolves with the session it ended in. */
  private async send(
    id: string,
    mode: NarratorMode,
    text: string,
    signal: AbortSignal,
    onLine?: (line: string) => void
  ): Promise<{ id: string; text: string }> {
    if (!this.providers.length) await this.loadProviders().catch(() => {})
    for (;;) {
      const model = this.candidates()[0]
      let wrote = false
      try {
        const reply = await this.ask(id, mode, text, model, signal, (line) => {
          wrote = true
          onLine?.(line)
        })
        return { id, text: reply }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        if (signal.aborted || wrote || !model || !isUnavailable(message)) throw e
        console.info(
          `[whiteboard] ${modelKey(model)} is unavailable, trying the next model`,
          message
        )
        this.unavailable.set(modelKey(model), Date.now() + SKIP_MS)
        void this.loadProviders().catch(() => {})
        if (!this.candidates().length) throw e
        // The failed exchange stays in that session; start clean.
        this.remove(id)
        id = await this.create()
      }
    }
  }

  private async ask(
    id: string,
    mode: NarratorMode,
    text: string,
    model: SelectedModel | undefined,
    signal: AbortSignal,
    onLine: (line: string) => void
  ): Promise<string> {
    await this.connect()
    signal.throwIfAborted()
    return new Promise<string>((resolve, reject) => {
      const assistant = new Set<string>()
      const textParts = new Set<string>()
      let reply = ''
      let sent = 0
      let lastPart: string | undefined
      let ended = false
      const lines = (final: boolean): void => {
        for (let nl = reply.indexOf('\n', sent); nl >= 0; nl = reply.indexOf('\n', sent)) {
          onLine(reply.slice(sent, nl))
          sent = nl + 1
        }
        if (final && sent < reply.length) {
          onLine(reply.slice(sent))
          sent = reply.length
        }
      }
      const end = (error?: Error): void => {
        if (ended) return
        ended = true
        this.listeners.delete(id)
        signal.removeEventListener('abort', abort)
        if (error) return reject(error)
        if (reply.trim()) {
          lines(true)
          return resolve(reply)
        }
        // Nothing streamed (a provider that sends the text only when done): read it back.
        void this.lastReply(id).then((t) => {
          reply = t
          lines(true)
          resolve(reply)
        }, reject)
      }
      const abort = (): void => {
        void this.client.session
          .abort({ path: { id }, query: { directory: this.directory } })
          .catch(() => {})
        end(new DOMException('The narrator was interrupted.', 'AbortError'))
      }
      signal.addEventListener('abort', abort, { once: true })
      this.listeners.set(id, {
        fail: end,
        event: (e) => {
          const p = e.properties ?? {}
          if (e.type === 'message.updated') {
            if (p.info?.role === 'assistant' && p.info.id) assistant.add(p.info.id)
            if (p.info?.role === 'assistant' && p.info.error) end(toError(p.info.error))
          } else if (e.type === 'message.part.updated') {
            const part = p.part
            if (part?.type !== 'text' || !part.id || part.synthetic) return
            if (!part.messageID || !assistant.has(part.messageID)) return
            if (!textParts.has(part.id)) {
              textParts.add(part.id)
              // A second text part is a new line, not a continuation of the last one.
              if (lastPart && reply && !reply.endsWith('\n')) reply += '\n'
              lastPart = part.id
            }
          } else if (e.type === 'message.part.delta') {
            if (p.field !== 'text' || !p.partID || !textParts.has(p.partID) || !p.delta) return
            reply += p.delta
            lines(false)
          } else if (e.type === 'session.status' && p.status?.type === 'retry') {
            // Left alone, opencode retries until the limit lifts; the person is waiting now.
            void this.client.session
              .abort({ path: { id }, query: { directory: this.directory } })
              .catch(() => {})
            end(new Error(p.status.message || 'The model is busy.'))
          } else if (e.type === 'session.error') {
            end(toError(p.error))
          } else if (e.type === 'session.idle') {
            end()
          }
        }
      })
      this.client.session
        .promptAsync({
          path: { id },
          query: { directory: this.directory },
          body: {
            agent: NARRATOR_AGENTS[mode],
            ...(model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
            parts: [{ type: 'text', text }] as never
          },
          throwOnError: true,
          signal
        })
        .catch((err: unknown) => {
          if (!signal.aborted) end(err instanceof Error ? err : new Error(String(err)))
        })
    })
  }

  /** The text of the session's last assistant message. */
  private async lastReply(id: string): Promise<string> {
    const result = await this.client.session.messages({
      path: { id },
      query: { directory: this.directory },
      throwOnError: true
    })
    const last = (result.data as MessagesReply[]).filter((m) => m.info?.role === 'assistant').at(-1)
    return (last?.parts ?? [])
      .filter((p) => p.type === 'text' && !p.synthetic && p.text)
      .map((p) => p.text as string)
      .join('\n')
  }

  /** One event stream for every session; resolves once the server has said hello. */
  private connect(): Promise<void> {
    this.connected ??= new Promise<void>((ready, failed) => {
      void (async () => {
        try {
          const { stream } = await this.client.event.subscribe({
            query: { directory: this.directory },
            signal: this.stop.signal
          })
          for await (const raw of stream) {
            ready()
            const e = raw as RawEvent
            const id = e.properties?.sessionID
            if (id) this.listeners.get(id)?.event(e)
          }
          throw new Error('The narrator stopped sending events.')
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err))
          failed(error)
          this.connected = null
          for (const l of [...this.listeners.values()]) l.fail(error)
        }
      })()
    })
    return this.connected
  }
}

function toError(e: RawError | undefined): Error {
  return new Error(e?.data?.message || e?.name || 'The narrator failed.')
}
