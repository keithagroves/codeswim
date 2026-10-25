import { describe, expect, it } from 'vitest'
import { cleanTranscript, Endpointer, resample, rms, type EndpointEvent } from './listen'

const RATE = 16000
const FRAME = 1024 // 64 ms

/** Frames of a sine tone (speech) or faint noise (the room), `ms` long. */
function frames(ms: number, amplitude: number): Float32Array[] {
  const out: Float32Array[] = []
  let n = Math.round((ms / 1000) * RATE)
  let t = 0
  while (n > 0) {
    const f = new Float32Array(Math.min(FRAME, n))
    for (let i = 0; i < f.length; i++, t++)
      f[i] = amplitude * Math.sin((2 * Math.PI * 220 * t) / RATE)
    out.push(f)
    n -= f.length
  }
  return out
}

function feed(ep: Endpointer, ...parts: Float32Array[][]): EndpointEvent[] {
  const events: EndpointEvent[] = []
  for (const part of parts)
    for (const f of part) {
      const e = ep.push(f)
      if (e) events.push(e)
    }
  return events
}

const room = (ms: number): Float32Array[] => frames(ms, 0.002)
const voice = (ms: number): Float32Array[] => frames(ms, 0.2)

describe('Endpointer', () => {
  it('turns speech between pauses into one utterance, with a little audio from before it', () => {
    const ep = new Endpointer()
    const events = feed(ep, room(1000), voice(1500), room(1200))
    expect(events.map((e) => e.type)).toEqual(['start', 'end'])
    const end = events[1] as Extract<EndpointEvent, { type: 'end' }>
    const seconds = end.audio.length / RATE
    // 1.5 s of speech, plus up to ~0.35 s before it and 0.2 s of the pause after.
    expect(seconds).toBeGreaterThan(1.5)
    expect(seconds).toBeLessThan(2.2)
  })

  it('ignores a click too short to be speech', () => {
    const ep = new Endpointer()
    expect(feed(ep, room(1000), voice(100), room(1500))).toEqual([])
    expect(ep.collecting).toBe(false)
  })

  it('keeps one utterance across a short pause mid-sentence', () => {
    const ep = new Endpointer()
    const events = feed(ep, room(500), voice(600), room(400), voice(600), room(1000))
    expect(events.map((e) => e.type)).toEqual(['start', 'end'])
  })

  it('ends a long utterance at the limit', () => {
    const ep = new Endpointer({ maxMs: 2000 })
    const events = feed(ep, room(500), voice(5000))
    expect(events.filter((e) => e.type === 'end').length).toBeGreaterThanOrEqual(2)
  })

  it('reset drops what was collected', () => {
    const ep = new Endpointer()
    feed(ep, room(500), voice(600))
    expect(ep.collecting).toBe(true)
    ep.reset()
    expect(ep.collecting).toBe(false)
    expect(feed(ep, room(1500))).toEqual([])
  })

  it('learns a noisy room instead of hearing it as speech', () => {
    const ep = new Endpointer()
    const fan = (ms: number): Float32Array[] => frames(ms, 0.03)
    expect(feed(ep, fan(3000))).toEqual([])
    expect(feed(ep, frames(800, 0.3), fan(1200)).map((e) => e.type)).toEqual(['start', 'end'])
  })
})

describe('resample', () => {
  it('changes the length by the rate ratio and keeps the signal', () => {
    const one = new Float32Array(48000).fill(0.5)
    const out = resample(one, 48000, RATE)
    expect(out.length).toBe(RATE)
    expect(rms(out)).toBeCloseTo(0.5)
    expect(resample(one, RATE, RATE)).toBe(one)
  })
})

describe('cleanTranscript', () => {
  it('keeps what was said and drops sound tags', () => {
    expect(cleanTranscript(' Make the buttons wider. ')).toBe('Make the buttons wider.')
    expect(cleanTranscript('[BLANK_AUDIO] Yes, build it. (keyboard clicking)')).toBe(
      'Yes, build it.'
    )
  })

  it('treats silence and its usual hallucinations as nothing', () => {
    for (const t of [
      '[BLANK_AUDIO]',
      ' you',
      'Thank you.',
      'Thanks for watching!',
      '♪♪',
      '(music)',
      ' . '
    ])
      expect(cleanTranscript(t)).toBe('')
    expect(cleanTranscript('Yes.')).toBe('Yes.')
  })
})
