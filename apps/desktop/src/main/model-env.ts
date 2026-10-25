// Where the speech workers (voice-worker.ts, listen-worker.ts) get their
// models: the copy shipped with the app, or Hugging Face into a cache.

import { env } from '@huggingface/transformers'

export function selectModels(cacheDir: string, modelDir?: string): void {
  env.cacheDir = cacheDir
  if (modelDir) {
    // Read <modelDir>/<repo>/<file>, and never reach for the network.
    env.localModelPath = modelDir
    env.allowLocalModels = true
    env.allowRemoteModels = false
  }
}
