// The narrator's transport: hidden sessions on the narrator's own opencode
// server (main/sidecar.ts, startNarratorSidecar).
//
// Every request runs in `directory` — the narrator's empty directory, never
// the workspace — as one of the narrator agents (prompts/index.ts). Sessions
// are created ahead of time, so a question never waits on session.create,
// and deleted when the turn is done with them. Each request carries the whole
// conversation in its text (turn.ts, composePrompt), so a session never needs
// to outlive its turn.

import { createOpencodeClient } from '@opencode-ai/sdk/client'
import {
  NARRATOR_AGENTS,
  NARRATOR_SESSION_TITLE,
  type NarratorConversation,
  type NarratorMode,
  type NarratorTransport
} from '@codeswim/whiteboard'
import type { SelectedModel } from '../agent'

const MODES: NarratorMode[] = ['opener', 'main', 'walkthrough']
/** Spare sessions kept ready per mode. */
const POOL_SIZE = 1

interface PromptReply {
  info?: { error?: { name?: string; data?: { message?: string } } }
  parts?: Array<{ type?: string; text?: string; synthetic?: boolean }>
}

export class OpencodeNarrator implements NarratorTransport {
  private readonly client: ReturnType<typeof createOpencodeClient>
  private readonly pool: Record<NarratorMode, Promise<string>[]> = {
    opener: [],
    main: [],
    walkthrough: []
  }

  constructor(
    url: string,
    private readonly directory: string,
    private readonly model: () => SelectedModel | undefined
  ) {
    this.client = createOpencodeClient({ baseUrl: url, directory })
  }

  /** Create the spare sessions now, so the first question is as fast as the rest. */
  warm(): void {
    for (const mode of MODES) this.refill(mode)
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
      send: (text, signal) => this.send(id, mode, text, signal),
      close: () => {
        void this.client.session
          .delete({ path: { id }, query: { directory: this.directory } })
          .catch(() => {})
      }
    }
  }

  /** Delete the spare sessions (the view is going away for good). */
  dispose(): void {
    for (const mode of MODES) {
      for (const pending of this.pool[mode].splice(0)) {
        void pending
          .then((id) =>
            this.client.session.delete({ path: { id }, query: { directory: this.directory } })
          )
          .catch(() => {})
      }
    }
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

  private async send(
    id: string,
    mode: NarratorMode,
    text: string,
    signal: AbortSignal
  ): Promise<string> {
    const stop = (): void => {
      void this.client.session
        .abort({ path: { id }, query: { directory: this.directory } })
        .catch(() => {})
    }
    signal.addEventListener('abort', stop, { once: true })
    try {
      const model = this.model()
      const result = await this.client.session.prompt({
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
      const data = result.data as PromptReply
      if (data.info?.error) {
        throw new Error(
          data.info.error.data?.message || data.info.error.name || 'The narrator failed.'
        )
      }
      return (data.parts ?? [])
        .filter((p) => p.type === 'text' && !p.synthetic && p.text)
        .map((p) => p.text as string)
        .join('\n')
    } finally {
      signal.removeEventListener('abort', stop)
    }
  }
}
