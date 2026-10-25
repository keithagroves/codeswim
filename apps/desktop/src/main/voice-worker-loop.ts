// The voice worker's message loop (voice-worker.ts is the utility-process
// entry). Kept free of kokoro-js so it can be tested without loading a model.

import type { FromVoiceWorker, ToVoiceWorker } from './voice-protocol'

type SpeakRequest = Extract<ToVoiceWorker, { type: 'speak' }>

export interface VoicePort {
  post(message: FromVoiceWorker): void
  onMessage(handler: (message: ToVoiceWorker) => void): void
}

export interface VoiceEngine {
  load(
    cacheDir: string,
    onProgress: (file: string, loaded: number, total: number) => void,
    modelDir?: string
  ): Promise<void>
  generate(
    text: string,
    voice: string,
    speed: number
  ): Promise<{ samples: Float32Array; sampleRate: number }>
}

/**
 * The worker's message loop, separate from the utility-process plumbing so it
 * can be driven in tests. Sentences are synthesized one at a time, in order;
 * `cancel` drops the ones that haven't started.
 */
export function runVoiceWorker(port: VoicePort, engine: VoiceEngine): void {
  const queue: SpeakRequest[] = []
  const background: SpeakRequest[] = []
  let ready = false
  let busy = false

  const pump = async (): Promise<void> => {
    if (busy || !ready) return
    busy = true
    while (queue.length || background.length) {
      const req = (queue.length ? queue : background).shift()!
      try {
        const { samples, sampleRate } = await engine.generate(req.text, req.voice, req.speed)
        port.post({ type: 'audio', id: req.id, samples, sampleRate })
      } catch (e) {
        port.post({
          type: 'speak-error',
          id: req.id,
          message: e instanceof Error ? e.message : String(e)
        })
      }
    }
    busy = false
  }

  port.onMessage((msg) => {
    switch (msg.type) {
      case 'load':
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
        return
      case 'speak':
        ;(msg.background ? background : queue).push(msg)
        void pump()
        return
      case 'cancel':
        for (const req of queue.splice(0)) {
          port.post({ type: 'speak-error', id: req.id, message: 'cancelled' })
        }
        return
    }
  })
}
