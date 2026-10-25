// The Kokoro voice worker: an Electron utility process (forked by voice.ts)
// that loads Kokoro once and turns sentences into 24 kHz PCM.
//
// kokoro-js and transformers.js are bundled into this file by electron-vite;
// only the native ONNX runtime (onnxruntime-node) is loaded from
// node_modules. The voice style files are copied next to the build output
// (electron.vite.config.ts, copyKokoroVoices) because kokoro-js reads them
// from `<its dir>/../voices`. The model itself is downloaded from Hugging Face
// The model ships with the app (`modelDir`, see scripts/fetch-models.mjs);
// without it, it's downloaded on first use into `cacheDir`.

import { KokoroTTS } from 'kokoro-js'
import { VOICE_DTYPE, VOICE_MODEL, type ToVoiceWorker } from './voice-protocol'
import { selectModels } from './model-env'
import { runVoiceWorker, type VoiceEngine } from './voice-worker-loop'

/** The real engine: Kokoro on onnxruntime-node, CPU. */
export function kokoroEngine(): VoiceEngine {
  let tts: KokoroTTS | null = null
  return {
    async load(cacheDir, onProgress, modelDir) {
      selectModels(cacheDir, modelDir)
      tts = await KokoroTTS.from_pretrained(VOICE_MODEL, {
        dtype: VOICE_DTYPE,
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
      })
    },
    async generate(text, voice, speed) {
      if (!tts) throw new Error('The voice is not loaded.')
      const audio = await tts.generate(text, { voice: voice as never, speed })
      return { samples: audio.audio, sampleRate: audio.sampling_rate }
    }
  }
}

// In the utility process, wire the loop to the parent port.
const parentPort = (process as unknown as { parentPort?: Electron.ParentPort }).parentPort
if (parentPort) {
  runVoiceWorker(
    {
      post: (message) => parentPort.postMessage(message),
      onMessage: (handler) => parentPort.on('message', (e) => handler(e.data as ToVoiceWorker))
    },
    kokoroEngine()
  )
}
