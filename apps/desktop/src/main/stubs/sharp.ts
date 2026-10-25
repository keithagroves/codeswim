// transformers.js imports `sharp` for image inputs at module load. The voice
// worker only does text-to-speech, so the bundle gets this stub instead of
// shipping sharp's native binaries (electron.vite.config.ts, resolve.alias).
export default function sharp(): never {
  throw new Error('sharp is not available in the voice worker')
}
