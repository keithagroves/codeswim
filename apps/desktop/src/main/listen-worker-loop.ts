// The speech-recognition worker's message loop (listen-worker.ts is the
// utility-process entry). Kept free of transformers.js so it can be tested
// without loading a model.

import type { FromListenWorker, ToListenWorker } from './listen-protocol'

export interface ListenPort {
  post(message: FromListenWorker): void
  onMessage(handler: (message: ToListenWorker) => void): void
}

export interface ListenEngine {
  load(
    cacheDir: string,
    onProgress: (file: string, loaded: number, total: number) => void,
    modelDir?: string
  ): Promise<void>
  transcribe(samples: Float32Array): Promise<string>
}

/** Utterances are transcribed one at a time, in the order they were heard. */
export function runListenWorker(port: ListenPort, engine: ListenEngine): void {
  const queue: Extract<ToListenWorker, { type: 'transcribe' }>[] = []
  let ready = false
  let busy = false

  const pump = async (): Promise<void> => {
    if (busy || !ready) return
    busy = true
    while (queue.length) {
      const req = queue.shift()!
      try {
        port.post({ type: 'text', id: req.id, text: await engine.transcribe(req.samples) })
      } catch (e) {
        port.post({
          type: 'transcribe-error',
          id: req.id,
          message: e instanceof Error ? e.message : String(e)
        })
      }
    }
    busy = false
  }

  port.onMessage((msg) => {
    if (msg.type === 'load') {
      engine
        .load(
          msg.cacheDir,
          (file, loaded, total) => port.post({ type: 'progress', file, loaded, total }),
          msg.modelDir
        )
        .then(() => {
          ready = true
          port.post({ type: 'ready' })
          void pump()
        })
        .catch((e) =>
          port.post({ type: 'load-error', message: e instanceof Error ? e.message : String(e) })
        )
    } else if (msg.type === 'transcribe') {
      queue.push(msg)
      void pump()
    }
  })
}
