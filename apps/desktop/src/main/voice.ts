// The natural (Kokoro) voice for the whiteboard, owned by main.
//
// Synthesis runs in a utility process (voice-worker.ts) so the main process
// never blocks. The model (~163 MB) is downloaded from Hugging Face the first
// time the person installs the voice, by that worker, into userData — the
// renderer stays offline and its CSP doesn't change. Audio goes back to the
// renderer as 24 kHz PCM over IPC and plays through Web Audio.

import path from 'node:path'
import type { VoiceStatus } from '@codeswim/contract'
import {
  VOICE_DOWNLOAD_MB,
  VOICE_IDS,
  VOICE_MODEL,
  VOICE_MODEL_FILE,
  type FromVoiceWorker,
  type ToVoiceWorker,
  type VoiceId
} from './voice-protocol'

/** The utility process, as VoiceHost sees it. */
export interface VoiceWorkerHandle {
  post(message: ToVoiceWorker): void
  onMessage(handler: (message: FromVoiceWorker) => void): void
  onExit(handler: (code: number) => void): void
  kill(): void
}

export interface VoiceHostOptions {
  cacheDir: string
  /** The models shipped with the app (scripts/fetch-models.mjs), if any. */
  bundledDir?: string
  spawn(): VoiceWorkerHandle
  exists(file: string): boolean
  notify(status: VoiceStatus): void
}

export interface SpokenAudio {
  samples: Float32Array
  sampleRate: number
}

/** The longest sentence we'll synthesize; the narrator speaks under 20 words. */
export const MAX_SPOKEN_CHARS = 600

export function isVoiceId(v: unknown): v is VoiceId {
  return typeof v === 'string' && (VOICE_IDS as readonly string[]).includes(v)
}

export class VoiceHost {
  private worker: VoiceWorkerHandle | null = null
  private loading: Promise<void> | null = null
  private ready = false
  private state: VoiceStatus['state'] = 'idle'
  private error: string | null = null
  private files = new Map<string, { loaded: number; total: number }>()
  private seq = 1
  private pending = new Map<number, { resolve(a: SpokenAudio): void; reject(e: Error): void }>()

  constructor(private readonly opts: VoiceHostOptions) {}

  /** Where the model lands on disk (transformers.js cache layout). */
  get modelPath(): string {
    return path.join(this.opts.cacheDir, ...VOICE_MODEL.split('/'), ...VOICE_MODEL_FILE.split('/'))
  }
  /** Whether the model shipped with the app, so nothing needs downloading. */
  private get bundled(): boolean {
    const dir = this.opts.bundledDir
    return (
      !!dir &&
      this.opts.exists(path.join(dir, ...VOICE_MODEL.split('/'), ...VOICE_MODEL_FILE.split('/')))
    )
  }

  status(): VoiceStatus {
    let progress: number | null = null
    if (this.state === 'downloading') {
      let loaded = 0
      let total = 0
      for (const f of this.files.values()) {
        loaded += f.loaded
        total += f.total
      }
      progress = total ? Math.min(1, loaded / total) : 0
    }
    return {
      available: true,
      installed: this.ready || this.bundled || this.opts.exists(this.modelPath),
      state: this.state,
      progress,
      error: this.error,
      downloadMb: VOICE_DOWNLOAD_MB
    }
  }

  private setState(state: VoiceStatus['state'], error: string | null = null): void {
    this.state = state
    this.error = error
    this.opts.notify(this.status())
  }

  /** Download (first time) and load the voice. Resolves when it can speak. */
  install(): Promise<void> {
    if (this.ready) return Promise.resolve()
    if (this.loading) return this.loading
    this.files.clear()
    const bundled = this.bundled
    this.setState(bundled || this.opts.exists(this.modelPath) ? 'loading' : 'downloading')
    this.loading = new Promise<void>((resolve, reject) => {
      const worker = this.spawnWorker()
      const fail = (message: string): void => {
        this.loading = null
        this.setState('error', message)
        reject(new Error(message))
      }
      worker.onMessage((msg) => {
        if (msg.type === 'progress') {
          this.files.set(msg.file, { loaded: msg.loaded, total: msg.total })
          const done = [...this.files.values()].every((f) => f.loaded >= f.total)
          const hasModel = [...this.files.keys()].some((f) => f.endsWith('.onnx'))
          if (this.state === 'downloading' && done && hasModel) {
            this.setState('loading')
          } else if (this.state === 'downloading') {
            this.opts.notify(this.status())
          }
        } else if (msg.type === 'ready') {
          this.ready = true
          this.loading = null
          this.setState('ready')
          resolve()
        } else if (msg.type === 'load-error') {
          fail(msg.message)
        }
      })
      worker.onExit(() => {
        if (!this.ready && this.loading) fail('The voice process stopped while loading.')
      })
      worker.post({
        type: 'load',
        cacheDir: this.opts.cacheDir,
        ...(bundled ? { modelDir: this.opts.bundledDir } : {})
      })
    })
    return this.loading
  }

  /** One sentence, as PCM. The voice must be installed and loaded. */
  speak(text: string, voice: VoiceId, speed = 1, background = false): Promise<SpokenAudio> {
    if (!this.ready || !this.worker)
      return Promise.reject(new Error('The natural voice is not loaded.'))
    const clean = text.trim().slice(0, MAX_SPOKEN_CHARS)
    if (!clean) return Promise.resolve({ samples: new Float32Array(0), sampleRate: 24000 })
    const id = this.seq++
    return new Promise<SpokenAudio>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker!.post({
        type: 'speak',
        id,
        text: clean,
        voice,
        speed,
        ...(background ? { background: true } : {})
      })
    })
  }

  /** Drop sentences that haven't been synthesized yet (the person interrupted). */
  cancel(): void {
    this.worker?.post({ type: 'cancel' })
  }

  dispose(): void {
    this.worker?.kill()
    this.worker = null
    this.ready = false
    for (const p of this.pending.values()) p.reject(new Error('The voice process stopped.'))
    this.pending.clear()
  }

  private spawnWorker(): VoiceWorkerHandle {
    if (this.worker) return this.worker
    const worker = this.opts.spawn()
    this.worker = worker
    worker.onMessage((msg) => {
      if (msg.type === 'audio') {
        this.pending.get(msg.id)?.resolve({ samples: msg.samples, sampleRate: msg.sampleRate })
        this.pending.delete(msg.id)
      } else if (msg.type === 'speak-error') {
        this.pending.get(msg.id)?.reject(new Error(msg.message))
        this.pending.delete(msg.id)
      }
    })
    worker.onExit(() => {
      if (this.worker !== worker) return
      this.worker = null
      const wasReady = this.ready
      this.ready = false
      for (const p of this.pending.values()) p.reject(new Error('The voice process stopped.'))
      this.pending.clear()
      if (wasReady) this.setState('idle')
    })
    return worker
  }
}
