// Speech mode's ears: deciding when the person started and stopped talking,
// and tidying what the speech model heard.
//
// The microphone delivers short frames; the Endpointer turns them into whole
// utterances. A frame counts as speech when it's clearly louder than the
// room (a noise floor it keeps learning between utterances), an utterance
// starts once there's been enough speech to not be a cough or a click, and
// it ends after a pause. Each utterance carries a little audio from just
// before it started, so the first syllable isn't clipped.

/** The rate the speech model wants. */
export const LISTEN_SAMPLE_RATE = 16000

export interface EndpointerOptions {
  sampleRate?: number
  /** Speech needed before an utterance counts (shorter is a cough or a click). */
  minSpeechMs?: number
  /** The pause that ends an utterance. */
  endSilenceMs?: number
  /** Audio kept from before the speech started. */
  preRollMs?: number
  /** An utterance this long ends regardless. */
  maxMs?: number
}

export type EndpointEvent = { type: 'start' } | { type: 'end'; audio: Float32Array }

/** Speech must be this much louder than the room... */
const OVER_FLOOR = 3
/** ...and never quieter than this (RMS of samples in -1..1). */
const MIN_LEVEL = 0.01

export function rms(frame: Float32Array): number {
  let sum = 0
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
  return frame.length ? Math.sqrt(sum / frame.length) : 0
}

export class Endpointer {
  private readonly rate: number
  private readonly minSpeech: number
  private readonly endSilence: number
  private readonly preRoll: number
  private readonly max: number
  private floor: number | null = null
  private pre: Float32Array[] = []
  private preLength = 0
  private chunks: Float32Array[] = []
  private length = 0
  private voiced = 0
  private silence = 0
  private started = false
  /** The last frame's loudness against the speech threshold, 0..1, for a level meter. */
  level = 0

  constructor(opts: EndpointerOptions = {}) {
    this.rate = opts.sampleRate ?? LISTEN_SAMPLE_RATE
    const samples = (ms: number): number => Math.round((ms / 1000) * this.rate)
    this.minSpeech = samples(opts.minSpeechMs ?? 250)
    this.endSilence = samples(opts.endSilenceMs ?? 800)
    this.preRoll = samples(opts.preRollMs ?? 300)
    this.max = samples(opts.maxMs ?? 30_000)
  }

  /** Whether an utterance is being collected (speech heard, no long pause yet). */
  get collecting(): boolean {
    return this.chunks.length > 0
  }

  push(frame: Float32Array): EndpointEvent | null {
    const level = rms(frame)
    const threshold = Math.max(MIN_LEVEL, (this.floor ?? level) * OVER_FLOOR)
    const speech = level >= threshold
    this.level = Math.min(1, level / (threshold * 2))

    if (!this.collecting) {
      if (!speech) {
        // Learn the room while nobody's talking, slowly, so a word doesn't raise it.
        this.floor = this.floor === null ? level : this.floor * 0.95 + level * 0.05
        this.keepPreRoll(frame)
        return null
      }
      this.chunks = [...this.pre]
      this.length = this.preLength
      this.pre = []
      this.preLength = 0
      this.voiced = 0
      this.silence = 0
    }

    this.chunks.push(frame)
    this.length += frame.length
    if (speech) {
      this.voiced += frame.length
      this.silence = 0
    } else {
      this.silence += frame.length
    }

    let event: EndpointEvent | null = null
    if (!this.started && this.voiced >= this.minSpeech) {
      this.started = true
      event = { type: 'start' }
    }
    if (this.silence >= this.endSilence || this.length >= this.max) {
      const audio = this.started ? this.take() : null
      this.reset()
      return audio ? { type: 'end', audio } : event
    }
    return event
  }

  /** Drop anything collected (the narrator started talking, or listening stopped). Keeps the noise floor. */
  reset(): void {
    this.chunks = []
    this.length = 0
    this.pre = []
    this.preLength = 0
    this.voiced = 0
    this.silence = 0
    this.started = false
  }

  private keepPreRoll(frame: Float32Array): void {
    this.pre.push(frame)
    this.preLength += frame.length
    while (this.pre.length > 1 && this.preLength - this.pre[0].length >= this.preRoll) {
      this.preLength -= this.pre.shift()!.length
    }
  }

  private take(): Float32Array {
    // The trailing pause is just silence; keep a little of it.
    const keep = this.length - Math.max(0, this.silence - Math.round(this.rate * 0.2))
    const out = new Float32Array(keep)
    let at = 0
    for (const c of this.chunks) {
      if (at >= keep) break
      const part = c.subarray(0, Math.min(c.length, keep - at))
      out.set(part, at)
      at += part.length
    }
    return out
  }
}

/** Linear resampling, for a microphone that won't deliver 16 kHz itself. */
export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to || !samples.length) return samples
  const out = new Float32Array(Math.max(1, Math.round((samples.length * to) / from)))
  const step = from / to
  for (let i = 0; i < out.length; i++) {
    const x = i * step
    const j = Math.floor(x)
    const a = samples[Math.min(j, samples.length - 1)]
    const b = samples[Math.min(j + 1, samples.length - 1)]
    out[i] = a + (b - a) * (x - j)
  }
  return out
}

// What Whisper writes for audio with no words in it: sound tags, and a few
// phrases it hallucinates from silence or room noise (its training data was
// full of video outros).
const SOUND_TAG = /\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+/g
const HALLUCINATIONS = new Set([
  'you',
  'thank you',
  'thanks',
  'thank you for watching',
  'thanks for watching',
  'bye',
  'uh',
  'um',
  'hmm'
])

/** What the person said, or '' if the model heard no words. */
export function cleanTranscript(text: string): string {
  const t = text.replace(SOUND_TAG, ' ').replace(/\s+/g, ' ').trim()
  const bare = t
    .toLowerCase()
    .replace(/[^a-z' ]/g, '')
    .trim()
  if (!bare || HALLUCINATIONS.has(bare)) return ''
  return t
}
