// The speech-recognition worker: an Electron utility process (forked by
// listen.ts) that loads Whisper once and turns 16 kHz utterances into text.
//
// transformers.js is bundled into this file by electron-vite, as it is into
// the voice worker; only onnxruntime-node is loaded from node_modules. The
// model ships with the app (`modelDir`, see scripts/fetch-models.mjs);
// without it, it's downloaded from Hugging Face on first use into `cacheDir`.

import { pipeline } from '@huggingface/transformers'
import { LISTEN_DTYPE, LISTEN_MODEL, type ToListenWorker } from './listen-protocol'
import { selectModels } from './model-env'
import { runListenWorker, type ListenEngine } from './listen-worker-loop'

type Recognizer = (audio: Float32Array) => Promise<{ text: string } | { text: string }[]>

/** The real engine: Whisper on onnxruntime-node, CPU. */
export function whisperEngine(): ListenEngine {
  let asr: Recognizer | null = null
  return {
    async load(cacheDir, onProgress, modelDir) {
      selectModels(cacheDir, modelDir)
      asr = (await pipeline('automatic-speech-recognition', LISTEN_MODEL, {
        dtype: LISTEN_DTYPE,
        device: 'cpu',
        progress_callback: (p: {
          status?: string
          file?: string
          loaded?: number
          total?: number
        }) => {
          if (p.status === 'progress' && p.file && p.total)
            onProgress(p.file, p.loaded ?? 0, p.total)
        }
      })) as unknown as Recognizer
    },
    async transcribe(samples) {
      if (!asr) throw new Error('The speech model is not loaded.')
      const out = await asr(samples)
      return (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text).trim()
    }
  }
}

// In the utility process, wire the loop to the parent port.
const parentPort = (process as unknown as { parentPort?: Electron.ParentPort }).parentPort
if (parentPort) {
  runListenWorker(
    {
      post: (message) => parentPort.postMessage(message),
      onMessage: (handler) => parentPort.on('message', (e) => handler(e.data as ToListenWorker))
    },
    whisperEngine()
  )
}
