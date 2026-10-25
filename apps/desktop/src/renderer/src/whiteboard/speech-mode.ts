// Speech mode: talk to the whiteboard out loud, hands-free. The microphone
// listens, a sentence goes to the narrator when you pause, the narrator
// answers out loud, and listening picks up again when it's done.
//
// Turn-taking is half-duplex on purpose: while the narrator talks, what the
// mic hears is dropped, because its own voice (the OS voice especially)
// isn't reliably removed by echo cancellation and it would answer itself.
// Tapping the bar interrupts it. Speech recognition is Whisper in main
// (main/listen.ts), downloaded once with the person's go-ahead, like the
// natural voice; the mic itself is the OS's to grant.
//
// An external store (useSyncExternalStore) the chat and the board share. The
// mic level updates every frame, so it goes to onLevel listeners instead of
// the snapshot.

import type { DiagramNavApi, ListenStatus } from '@codeswim/contract'
import { cleanTranscript, Endpointer, LISTEN_SAMPLE_RATE, resample } from '@codeswim/whiteboard'

export type SpeechState =
  /** Not listening. */
  | 'off'
  /** Waiting for the person to agree to the speech model's download. */
  | 'offer'
  /** Downloading or loading the model, or waiting for the microphone. */
  | 'preparing'
  /** Listening for them to start. */
  | 'listening'
  /** They're talking. */
  | 'hearing'
  /** Turning what they said into text. */
  | 'transcribing'
  /** The narrator is answering; the mic is ignored until it's done. */
  | 'replying'
  | 'error'

export interface SpeechSnapshot {
  state: SpeechState
  /** What's happening while preparing ("Downloading the speech model… 40%"). */
  detail: string | null
  error: string | null
  downloadMb: number
}

export interface MicCapture {
  stop(): void
}

export interface SpeechBoard {
  talking(): boolean
  /** Send what they said to the narrator. */
  ask(text: string): void
  /** Speech mode is pointless with a muted narrator. */
  unmute(): void
}

export interface SpeechModeDeps {
  api: Pick<
    DiagramNavApi,
    'listenStatus' | 'listenInstall' | 'listenTranscribe' | 'onListenStatus' | 'micAccess'
  >
  board: SpeechBoard
  openMic(onFrame: (samples: Float32Array, sampleRate: number) => void): Promise<MicCapture>
  now?(): number
  log?(...args: unknown[]): void
}

/** After the narrator stops, wait this long before listening (the room's echo, a breath). */
const RESUME_MS = 500
/** How long after asking to wait for the narrator to start before listening again anyway. */
const ASK_GRACE_MS = 4000

const MIC_DENIED =
  "Codeswim can't use the microphone. Allow it in System Settings → Privacy & Security → Microphone, then try again."

const cleanError = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  )

export class SpeechMode {
  private snapshot: SpeechSnapshot = { state: 'off', detail: null, error: null, downloadMb: 77 }
  private listeners = new Set<() => void>()
  private levelListeners = new Set<(level: number) => void>()
  private status: ListenStatus | null = null
  private started = false
  private gen = 0
  private mic: MicCapture | null = null
  private endpointer = new Endpointer()
  private askedAt = 0
  private sawReply = false
  private resumeAt = 0

  constructor(private readonly deps: SpeechModeDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): SpeechSnapshot => this.snapshot

  /** The mic level (0..1) every frame while listening, for a meter. */
  onLevel(listener: (level: number) => void): () => void {
    this.levelListeners.add(listener)
    return () => this.levelListeners.delete(listener)
  }

  get active(): boolean {
    return this.snapshot.state !== 'off'
  }

  private set(next: Partial<SpeechSnapshot>): void {
    const merged = { ...this.snapshot, ...next }
    if (
      merged.state === this.snapshot.state &&
      merged.detail === this.snapshot.detail &&
      merged.error === this.snapshot.error &&
      merged.downloadMb === this.snapshot.downloadMb
    )
      return
    this.snapshot = merged
    for (const l of this.listeners) l()
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private async loadStatus(): Promise<ListenStatus> {
    if (!this.started) {
      this.started = true
      this.deps.api.onListenStatus((s) => this.onStatus(s))
    }
    if (!this.status) this.onStatus(await this.deps.api.listenStatus())
    return this.status!
  }

  private onStatus(status: ListenStatus): void {
    this.status = status
    this.set({ downloadMb: status.downloadMb })
    if (this.snapshot.state !== 'preparing') return
    if (status.state === 'downloading') {
      const pct = status.progress === null ? '' : ` ${Math.round(status.progress * 100)}%`
      this.set({ detail: `Downloading the speech model…${pct}` })
    } else if (status.state === 'loading') {
      this.set({ detail: 'Loading the speech model…' })
    }
  }

  /** Turn speech mode on: straight to listening, or first the download offer. */
  async start(): Promise<void> {
    if (this.snapshot.state !== 'off' && this.snapshot.state !== 'error') return
    const gen = ++this.gen
    let status: ListenStatus
    try {
      status = await this.loadStatus()
    } catch (e) {
      if (gen === this.gen) this.set({ state: 'error', error: cleanError(e), detail: null })
      return
    }
    if (gen !== this.gen) return
    if (!status.available) {
      this.set({ state: 'error', error: 'Speech mode needs the desktop app.', detail: null })
      return
    }
    if (!status.installed) {
      this.set({ state: 'offer', error: null, detail: null })
      return
    }
    await this.prepare(gen)
  }

  /** They agreed to the download. */
  async accept(): Promise<void> {
    if (this.snapshot.state !== 'offer') return
    await this.prepare(++this.gen)
  }

  private async prepare(gen: number): Promise<void> {
    this.set({ state: 'preparing', error: null, detail: 'Loading the speech model…' })
    if (this.status) this.onStatus(this.status)
    try {
      this.onStatus(await this.deps.api.listenInstall())
      if (gen !== this.gen) return
      this.set({ detail: 'Waiting for the microphone…' })
      if (!(await this.deps.api.micAccess())) throw new Error(MIC_DENIED)
      if (gen !== this.gen) return
      const mic = await this.deps
        .openMic((samples, rate) => {
          if (gen === this.gen) this.onFrame(samples, rate)
        })
        .catch((e: unknown) => {
          const name = (e as { name?: string } | null)?.name
          throw name === 'NotAllowedError' ? new Error(MIC_DENIED) : e
        })
      if (gen !== this.gen) {
        mic.stop()
        return
      }
      this.mic = mic
      this.endpointer = new Endpointer()
      this.resumeAt = 0
      this.sawReply = false
      this.askedAt = 0
      this.deps.board.unmute()
      this.set({ state: this.deps.board.talking() ? 'replying' : 'listening', detail: null })
    } catch (e) {
      if (gen !== this.gen) return
      this.deps.log?.('[speech] could not start', e)
      this.set({ state: 'error', error: cleanError(e), detail: null })
    }
  }

  /** Turn speech mode off. */
  stop(): void {
    this.gen++
    this.mic?.stop()
    this.mic = null
    this.endpointer.reset()
    this.set({ state: 'off', detail: null, error: null })
    this.emitLevel(0)
  }

  private emitLevel(level: number): void {
    for (const l of this.levelListeners) l(level)
  }

  private onFrame(samples: Float32Array, rate: number): void {
    const state = this.snapshot.state
    if (state === 'transcribing') return
    if (state !== 'listening' && state !== 'hearing' && state !== 'replying') return
    const now = this.now()

    if (this.deps.board.talking()) {
      this.sawReply = true
      this.endpointer.reset()
      this.emitLevel(0)
      this.set({ state: 'replying' })
      return
    }
    if (state === 'replying') {
      // Just asked: give the narrator a moment to start before listening again.
      if (!this.sawReply && now - this.askedAt < ASK_GRACE_MS) return
      if (this.sawReply) this.resumeAt = now + RESUME_MS
      this.sawReply = false
      this.set({ state: 'listening' })
    }
    if (now < this.resumeAt) return

    const event = this.endpointer.push(resample(samples, rate, LISTEN_SAMPLE_RATE))
    this.emitLevel(this.endpointer.level)
    if (event?.type === 'start') this.set({ state: 'hearing' })
    else if (event?.type === 'end') void this.transcribe(event.audio)
    else if (state === 'hearing' && !this.endpointer.collecting) this.set({ state: 'listening' })
  }

  private async transcribe(audio: Float32Array): Promise<void> {
    const gen = this.gen
    this.set({ state: 'transcribing' })
    this.emitLevel(0)
    let text = ''
    try {
      text = cleanTranscript(await this.deps.api.listenTranscribe(audio))
    } catch (e) {
      this.deps.log?.('[speech] transcription failed', e)
    }
    if (gen !== this.gen) return
    if (!text) {
      this.set({ state: 'listening' })
      return
    }
    this.askedAt = this.now()
    this.sawReply = false
    this.set({ state: 'replying' })
    this.deps.board.ask(text)
  }
}

/** What speech mode is doing, in a few words. */
export function speechLabel(s: SpeechSnapshot): string {
  switch (s.state) {
    case 'offer':
      return `Speech mode uses a speech model that runs on this computer: a one-time ${s.downloadMb} MB download.`
    case 'preparing':
      return s.detail ?? 'Getting ready…'
    case 'listening':
      return 'Listening'
    case 'hearing':
      return 'Listening…'
    case 'transcribing':
      return 'Got it…'
    case 'replying':
      return 'Answering · tap to interrupt'
    case 'error':
      return s.error ?? "Speech mode couldn't start."
    case 'off':
      return ''
  }
}

/**
 * The real microphone: echo-cancelled mono at 16 kHz where the device allows
 * it, in 64 ms frames. A ScriptProcessorNode rather than an AudioWorklet: a
 * worklet needs its own module URL past the CSP, and frames this size are
 * nothing for the main thread.
 */
export async function openMicrophone(
  onFrame: (samples: Float32Array, sampleRate: number) => void
): Promise<MicCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1
    }
  })
  let ctx: AudioContext
  try {
    ctx = new AudioContext({ sampleRate: LISTEN_SAMPLE_RATE })
  } catch {
    ctx = new AudioContext()
  }
  const source = ctx.createMediaStreamSource(stream)
  const node = ctx.createScriptProcessor(1024, 1, 1)
  node.onaudioprocess = (e) =>
    onFrame(new Float32Array(e.inputBuffer.getChannelData(0)), ctx.sampleRate)
  source.connect(node)
  // A script processor only runs while connected; its output stays silent.
  node.connect(ctx.destination)
  await ctx.resume()
  return {
    stop() {
      node.onaudioprocess = null
      node.disconnect()
      source.disconnect()
      for (const t of stream.getTracks()) t.stop()
      void ctx.close()
    }
  }
}
