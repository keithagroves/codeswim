// Messages between main (voice.ts, VoiceHost) and the Kokoro voice worker
// (voice-worker.ts), which runs in an Electron utility process so speech
// synthesis never blocks the main process.

/** Kokoro-82M, ONNX export. Apache-2.0. */
export const VOICE_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX'
/**
 * fp16: ~163 MB, ~0.5 s per spoken sentence on Apple Silicon CPU (7-8x real
 * time). q8 is smaller (92 MB) but measured at half the speed; fp32 is the
 * same speed at twice the size.
 */
export const VOICE_DTYPE = 'fp16'
export const VOICE_MODEL_FILE = 'onnx/model_fp16.onnx'
export const VOICE_DOWNLOAD_MB = 163

/** The voices offered (and the only voice files shipped with the app). */
export const VOICE_IDS = ['af_heart', 'af_bella', 'am_michael', 'bf_emma', 'bm_george'] as const
export type VoiceId = (typeof VOICE_IDS)[number]

export type ToVoiceWorker =
  /**
   * `modelDir`: the models shipped with the app (fetch-models.mjs); when
   * set, the model is read from there and nothing is downloaded. Otherwise
   * it's downloaded into `cacheDir` the first time.
   */
  | { type: 'load'; cacheDir: string; modelDir?: string }
  /**
   * `background`: stock phrases rendered ahead of time. They wait behind
   * real sentences and survive a cancel.
   */
  | { type: 'speak'; id: number; text: string; voice: VoiceId; speed: number; background?: boolean }
  /** Drop queued sentences that haven't started (the person interrupted). */
  | { type: 'cancel' }

export type FromVoiceWorker =
  | { type: 'progress'; file: string; loaded: number; total: number }
  | { type: 'ready' }
  | { type: 'load-error'; message: string }
  | { type: 'audio'; id: number; samples: Float32Array; sampleRate: number }
  | { type: 'speak-error'; id: number; message: string }
