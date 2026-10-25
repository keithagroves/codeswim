// Speech out for the whiteboard. One `Speaker` per voice option; the turn
// scheduler (packages/whiteboard/src/turn.ts) only sees the interface.
//
// - SystemSpeaker: the OS voices through speechSynthesis. No dependencies and
//   no CSP change, and macOS ships decent voices.
// - CaptionSpeaker: muted. Nothing is heard, but each sentence still takes
//   about as long as reading it, so the drawing keeps its pace.
//
// - KokoroSpeaker (kokoro-speaker.ts): the natural voice, synthesized in
//   main's voice process. WhiteboardSpeaker picks between them.

import type { Speaker } from '@codeswim/whiteboard'
import type { KokoroSpeaker } from './kokoro-speaker'

/** Roughly how long it takes to read a sentence, so captions pace the drawing. */
export function readingMs(text: string): number {
  return Math.max(900, Math.min(6000, text.length * 55))
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true }
    )
  })

export class CaptionSpeaker implements Speaker {
  private ctl = new AbortController()

  async speak(text: string, onStart?: () => void): Promise<void> {
    onStart?.()
    await sleep(readingMs(text), this.ctl.signal)
  }

  cancel(): void {
    this.ctl.abort()
    this.ctl = new AbortController()
  }
}

// Voices that sound natural on macOS, best first. Premium/Enhanced variants
// only exist if the user downloaded them in System Settings.
const PREFERRED = [
  /\((Premium|Enhanced)\)/i,
  /^Ava\b/i,
  /^Zoe\b/i,
  /^Samantha\b/i,
  /^Allison\b/i,
  /^Evan\b/i,
  /^Alex\b/i,
  /Google US English/i
]

export function pickVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const english = voices.filter((v) => /^en(-|_|$)/i.test(v.lang))
  for (const pattern of PREFERRED) {
    const v = english.find(
      (x) => pattern.test(x.name) && x.localService && /en[-_]US/i.test(x.lang)
    )
    if (v) return v
  }
  return english.find((v) => /en[-_]US/i.test(v.lang) && v.localService) ?? english[0] ?? null
}

export class SystemSpeaker implements Speaker {
  // Chrome drops the events of an utterance that's been garbage-collected,
  // so the current one is kept referenced until it ends.
  private current: SpeechSynthesisUtterance | null = null
  private voice: SpeechSynthesisVoice | null = null

  static get available(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window
  }

  constructor() {
    if (!SystemSpeaker.available) return
    const load = (): void => {
      this.voice = pickVoice(speechSynthesis.getVoices())
    }
    load()
    speechSynthesis.addEventListener?.('voiceschanged', load)
  }

  speak(text: string, onStart?: () => void): Promise<void> {
    if (!SystemSpeaker.available) return new CaptionSpeaker().speak(text, onStart)
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text)
      if (this.voice) u.voice = this.voice
      u.rate = 1.05
      let started = false
      const begin = (): void => {
        if (started) return
        started = true
        onStart?.()
      }
      // In case the engine never reports the end (or never starts).
      const fallback = setTimeout(
        () => {
          begin()
          resolve()
        },
        3000 + text.length * 120
      )
      u.onstart = begin
      u.onend = u.onerror = () => {
        clearTimeout(fallback)
        begin()
        if (this.current === u) this.current = null
        resolve()
      }
      this.current = u
      speechSynthesis.speak(u)
    })
  }

  cancel(): void {
    if (!SystemSpeaker.available) return
    speechSynthesis.cancel()
    this.current = null
  }
}

/**
 * The speaker the whiteboard uses: the natural voice when it's chosen and
 * loaded, otherwise the system voice, or only captions when muted. Muting or
 * switching voices mid-sentence takes effect from the next sentence. If the
 * natural voice fails on a sentence, that sentence falls back to the system
 * voice rather than going silent.
 */
export class WhiteboardSpeaker implements Speaker {
  private readonly system = SystemSpeaker.available ? new SystemSpeaker() : null
  private readonly captions = new CaptionSpeaker()

  constructor(
    private readonly isMuted: () => boolean,
    private readonly natural: { speaker: KokoroSpeaker; active(): boolean } | null = null,
    private readonly log: (message: string, detail?: unknown) => void = () => {}
  ) {}

  private useNatural(): boolean {
    return !this.isMuted() && !!this.natural?.active()
  }

  prepare(text: string): void {
    if (this.useNatural()) this.natural!.speaker.prepare(text)
  }

  async speak(text: string, onStart?: () => void): Promise<void> {
    if (this.isMuted()) return this.captions.speak(text, onStart)
    if (this.useNatural()) {
      let started = false
      try {
        await this.natural!.speaker.speak(text, () => {
          started = true
          onStart?.()
        })
        return
      } catch (e) {
        this.log('[whiteboard] natural voice failed; using the system voice for this sentence', e)
        if (started) return
      }
    }
    if (!this.system) return this.captions.speak(text, onStart)
    return this.system.speak(text, onStart)
  }

  cancel(): void {
    this.natural?.speaker.cancel()
    this.system?.cancel()
    this.captions.cancel()
  }
}
