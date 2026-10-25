import { describe, expect, it } from 'vitest'
import type { ListenStatus } from '@codeswim/contract'
import { SpeechMode, type SpeechModeDeps } from './speech-mode'

const RATE = 16000
const FRAME = 1024
const FRAME_MS = (FRAME / RATE) * 1000

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function tone(amplitude: number): Float32Array {
  const f = new Float32Array(FRAME)
  for (let i = 0; i < FRAME; i++) f[i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / RATE)
  return f
}

interface Rig {
  speech: SpeechMode
  /** Feed `ms` of audio at `amplitude`, advancing the clock. */
  play(ms: number, amplitude: number): void
  asked: string[]
  transcribed: number[]
  setTalking(v: boolean): void
  micStopped(): boolean
  unmuted(): boolean
}

function setup(opts: { installed?: boolean; mic?: boolean; heard?: string } = {}): Rig {
  let status: ListenStatus = {
    available: true,
    installed: opts.installed ?? true,
    state: 'idle',
    progress: null,
    error: null,
    downloadMb: 77
  }
  let clock = 0
  let talking = false
  const asked: string[] = []
  const transcribed: number[] = []
  let onFrame: ((s: Float32Array, rate: number) => void) | null = null
  let micStopped = false
  let unmuted = false
  const deps: SpeechModeDeps = {
    api: {
      listenStatus: async () => status,
      listenInstall: async () => (status = { ...status, installed: true, state: 'ready' }),
      listenTranscribe: async (samples) => {
        transcribed.push(samples.length)
        return opts.heard ?? ' Make the buttons wider. '
      },
      onListenStatus: () => () => {},
      micAccess: async () => opts.mic ?? true
    },
    board: {
      talking: () => talking,
      ask: (text) => asked.push(text),
      unmute: () => (unmuted = true)
    },
    openMic: async (cb) => {
      onFrame = cb
      return { stop: () => (micStopped = true) }
    },
    now: () => clock
  }
  const speech = new SpeechMode(deps)
  const play = (ms: number, amplitude: number): void => {
    for (let t = 0; t < ms; t += FRAME_MS) {
      onFrame?.(tone(amplitude), RATE)
      clock += FRAME_MS
    }
  }
  return {
    speech,
    play,
    asked,
    transcribed,
    setTalking: (v) => {
      talking = v
    },
    micStopped: () => micStopped,
    unmuted: () => unmuted
  }
}

describe('SpeechMode', () => {
  it('listens, sends a sentence when they pause, and waits out the reply', async () => {
    const t = setup()
    await t.speech.start()
    expect(t.speech.getSnapshot().state).toBe('listening')
    expect(t.unmuted()).toBe(true)

    t.play(600, 0.002)
    t.play(1200, 0.2)
    expect(t.speech.getSnapshot().state).toBe('hearing')
    t.play(1000, 0.002)
    await tick()
    expect(t.asked).toEqual(['Make the buttons wider.'])
    expect(t.speech.getSnapshot().state).toBe('replying')

    // The narrator talks; the mic hears its voice, and it's ignored.
    t.setTalking(true)
    t.play(2000, 0.2)
    expect(t.transcribed.length).toBe(1)
    expect(t.speech.getSnapshot().state).toBe('replying')

    // It finishes; listening resumes after a short beat.
    t.setTalking(false)
    t.play(100, 0.002)
    expect(t.speech.getSnapshot().state).toBe('listening')
    t.play(1000, 0.002)
    t.play(800, 0.2)
    t.play(1000, 0.002)
    await tick()
    expect(t.asked.length).toBe(2)
  })

  it('offers the download first, and listens once they agree', async () => {
    const t = setup({ installed: false })
    await t.speech.start()
    expect(t.speech.getSnapshot()).toMatchObject({ state: 'offer', downloadMb: 77 })
    await t.speech.accept()
    expect(t.speech.getSnapshot().state).toBe('listening')
  })

  it('says how to allow the microphone when it was refused', async () => {
    const t = setup({ mic: false })
    await t.speech.start()
    expect(t.speech.getSnapshot()).toMatchObject({ state: 'error' })
    expect(t.speech.getSnapshot().error).toMatch(/System Settings/)
  })

  it('sends nothing when the model heard no words', async () => {
    const t = setup({ heard: ' [BLANK_AUDIO] ' })
    await t.speech.start()
    t.play(600, 0.002)
    t.play(800, 0.2)
    t.play(1000, 0.002)
    await tick()
    expect(t.transcribed.length).toBe(1)
    expect(t.asked).toEqual([])
    expect(t.speech.getSnapshot().state).toBe('listening')
  })

  it('stop releases the microphone and drops a sentence in flight', async () => {
    const t = setup()
    await t.speech.start()
    t.play(600, 0.002)
    t.play(800, 0.2)
    t.play(1000, 0.002)
    t.speech.stop()
    await tick()
    expect(t.micStopped()).toBe(true)
    expect(t.asked).toEqual([])
    expect(t.speech.getSnapshot().state).toBe('off')
  })
})
