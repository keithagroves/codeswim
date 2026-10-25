// The natural voice as a Speaker: sentences are synthesized by Kokoro in
// main's voice process (main/voice.ts) and played through Web Audio.
//
// Synthesis takes ~0.5 s a sentence, so the turn scheduler calls prepare()
// the moment a sentence is queued; by the time the previous sentence finishes
// playing, the next one is usually ready. The stock phrases (fillers, the
// walkthrough opener, the build question) are rendered once and kept.

import type { SpokenAudio } from '@codeswim/contract'
import type { Speaker } from '@codeswim/whiteboard'

/** The slice of AudioContext the speaker uses (a fake in tests). */
export interface AudioOut {
  readonly state: string
  readonly destination: AudioNode
  resume(): Promise<void>
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer
  createBufferSource(): AudioBufferSourceNode
}

export interface KokoroSpeakerDeps {
  /** One sentence as PCM, in the current voice. `background`: render behind real sentences. */
  synth(text: string, background?: boolean): Promise<SpokenAudio>
  /** Drop sentences main hasn't synthesized yet. */
  cancelRemote(): void
  /** Cache key for the current voice, so changing voices doesn't replay the old one. */
  voiceKey(): string
  audio(): AudioOut
}

export class KokoroSpeaker implements Speaker {
  private readonly queued = new Map<string, Promise<SpokenAudio>>()
  private readonly kept = new Map<string, Promise<SpokenAudio>>()
  private generation = 0
  private current: { source: AudioBufferSourceNode; done: () => void } | null = null

  constructor(private readonly deps: KokoroSpeakerDeps) {}

  private key(text: string): string {
    return `${this.deps.voiceKey()}\n${text}`
  }

  prepare(text: string): void {
    const key = this.key(text)
    if (this.queued.has(key) || this.kept.has(key)) return
    const audio = this.deps.synth(text)
    audio.catch(() => {}) // surfaced by speak()
    this.queued.set(key, audio)
  }

  /** Render phrases once and keep them (they survive cancel()). */
  keep(texts: readonly string[]): void {
    for (const text of texts) {
      const key = this.key(text)
      if (this.kept.has(key)) continue
      const audio = this.deps.synth(text, true)
      this.kept.set(key, audio)
      audio.catch(() => this.kept.delete(key))
    }
  }

  async speak(text: string, onStart?: () => void): Promise<void> {
    const generation = this.generation
    const key = this.key(text)
    const pending = this.kept.get(key) ?? this.queued.get(key) ?? this.deps.synth(text)
    this.queued.delete(key)
    let audio: SpokenAudio
    try {
      audio = await pending
    } catch (e) {
      if (generation !== this.generation) return // cancelled while waiting
      throw e
    }
    if (generation !== this.generation || !audio.samples.length) return
    const out = this.deps.audio()
    if (out.state === 'suspended') await out.resume().catch(() => {})
    const buffer = out.createBuffer(1, audio.samples.length, audio.sampleRate)
    buffer.copyToChannel(audio.samples as Float32Array<ArrayBuffer>, 0)
    await new Promise<void>((resolve) => {
      const source = out.createBufferSource()
      source.buffer = buffer
      source.connect(out.destination)
      const done = (): void => {
        if (this.current?.source === source) this.current = null
        resolve()
      }
      source.onended = done
      this.current = { source, done }
      onStart?.()
      source.start()
    })
  }

  cancel(): void {
    this.generation++
    this.queued.clear()
    const current = this.current
    this.current = null
    if (current) {
      try {
        current.source.stop()
      } catch {
        // Already stopped.
      }
      current.done()
    }
    this.deps.cancelRemote()
  }
}
