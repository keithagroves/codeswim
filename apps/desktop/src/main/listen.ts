// Speech recognition for the whiteboard's speech mode, owned by main.
//
// The renderer records the microphone and decides when a sentence ended
// (packages/whiteboard/src/listen.ts); each sentence comes here as 16 kHz PCM
// and goes to Whisper in a utility process (listen-worker.ts). Like the
// natural voice, the model (77 MB) is downloaded from Hugging Face only when
// the person agrees to, into userData, and everything runs offline after.

import path from 'node:path'
import type { ListenStatus } from '@codeswim/contract'
import {
  LISTEN_DOWNLOAD_MB,
  LISTEN_MAX_SAMPLES,
  LISTEN_MODEL,
  LISTEN_MODEL_FILE,
  type FromListenWorker,
  type ToListenWorker
} from './listen-protocol'

/** The utility process, as ListenHost sees it. */
export interface ListenWorkerHandle {
  post(message: ToListenWorker): void
  onMessage(handler: (message: FromListenWorker) => void): void
  onExit(handler: (code: number) => void): void
  kill(): void
}

export interface ListenHostOptions {
  cacheDir: string
  /** The models shipped with the app (scripts/fetch-models.mjs), if any. */
  bundledDir?: string
  spawn(): ListenWorkerHandle
  exists(file: string): boolean
  notify(status: ListenStatus): void
}

export class ListenHost {
  private worker: ListenWorkerHandle | null = null
  private loading: Promise<void> | null = null
  private ready = false
  private state: ListenStatus['state'] = 'idle'
  private error: string | null = null
  private files = new Map<string, { loaded: number; total: number }>()
  private seq = 1
  private pending = new Map<number, { resolve(text: string): void; reject(e: Error): void }>()

  constructor(private readonly opts: ListenHostOptions) {}

  /** Where the model lands on disk (transformers.js cache layout). */
  get modelPath(): string {
    return path.join(
      this.opts.cacheDir,
      ...LISTEN_MODEL.split('/'),
      ...LISTEN_MODEL_FILE.split('/')
    )
  }
  /** Whether the model shipped with the app, so nothing needs downloading. */
  private get bundled(): boolean {
    const dir = this.opts.bundledDir
    return (
      !!dir &&
      this.opts.exists(path.join(dir, ...LISTEN_MODEL.split('/'), ...LISTEN_MODEL_FILE.split('/')))
    )
  }

  status(): ListenStatus {
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
      downloadMb: LISTEN_DOWNLOAD_MB
    }
  }

  private setState(state: ListenStatus['state'], error: string | null = null): void {
    this.state = state
    this.error = error
    this.opts.notify(this.status())
  }

  /** Download (first time) and load the model. Resolves when it can transcribe. */
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
          if (this.state !== 'downloading') return
          const done = [...this.files.values()].every((f) => f.loaded >= f.total)
          // Two model files (encoder and decoder); loading starts after both.
          const models = [...this.files.keys()].filter((f) => f.endsWith('.onnx')).length
          if (done && models >= 2) this.setState('loading')
          else this.opts.notify(this.status())
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
        if (!this.ready && this.loading) fail('The speech process stopped while loading.')
      })
      worker.post({
        type: 'load',
        cacheDir: this.opts.cacheDir,
        ...(bundled ? { modelDir: this.opts.bundledDir } : {})
      })
    })
    return this.loading
  }

  /** One utterance (16 kHz mono) as text. The model must be installed and loaded. */
  transcribe(samples: Float32Array): Promise<string> {
    if (!this.ready || !this.worker)
      return Promise.reject(new Error('The speech model is not loaded.'))
    if (!samples.length) return Promise.resolve('')
    const id = this.seq++
    return new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker!.post({ type: 'transcribe', id, samples: samples.slice(0, LISTEN_MAX_SAMPLES) })
    })
  }

  dispose(): void {
    this.worker?.kill()
    this.worker = null
    this.ready = false
    for (const p of this.pending.values()) p.reject(new Error('The speech process stopped.'))
    this.pending.clear()
  }

  private spawnWorker(): ListenWorkerHandle {
    if (this.worker) return this.worker
    const worker = this.opts.spawn()
    this.worker = worker
    worker.onMessage((msg) => {
      if (msg.type === 'text') {
        this.pending.get(msg.id)?.resolve(msg.text)
        this.pending.delete(msg.id)
      } else if (msg.type === 'transcribe-error') {
        this.pending.get(msg.id)?.reject(new Error(msg.message))
        this.pending.delete(msg.id)
      }
    })
    worker.onExit(() => {
      if (this.worker !== worker) return
      this.worker = null
      const wasReady = this.ready
      this.ready = false
      for (const p of this.pending.values()) p.reject(new Error('The speech process stopped.'))
      this.pending.clear()
      if (wasReady) this.setState('idle')
    })
    return worker
  }
}
