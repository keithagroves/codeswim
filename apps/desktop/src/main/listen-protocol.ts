// Messages between main (listen.ts, ListenHost) and the speech-recognition
// worker (listen-worker.ts), a utility process like the voice's, so
// transcribing never blocks the main process or waits behind speech.

/** Whisper base (English), ONNX export. Apache-2.0. */
export const LISTEN_MODEL = 'onnx-community/whisper-base.en'
/**
 * q8: 77 MB, ~0.3 s to transcribe a 5 s sentence on Apple Silicon CPU, and
 * it caught every word of the test sentences. Small is ~3x the size.
 */
export const LISTEN_DTYPE = 'q8'
export const LISTEN_MODEL_FILE = 'onnx/decoder_model_merged_quantized.onnx'
export const LISTEN_DOWNLOAD_MB = 77
/** Whisper hears 16 kHz mono and at most 30 s at a time. */
export const LISTEN_MAX_SAMPLES = 16000 * 30

export type ToListenWorker =
  /** `modelDir`: as for the voice worker (voice-protocol.ts). */
  | { type: 'load'; cacheDir: string; modelDir?: string }
  | { type: 'transcribe'; id: number; samples: Float32Array }

export type FromListenWorker =
  | { type: 'progress'; file: string; loaded: number; total: number }
  | { type: 'ready' }
  | { type: 'load-error'; message: string }
  | { type: 'text'; id: number; text: string }
  | { type: 'transcribe-error'; id: number; message: string }
