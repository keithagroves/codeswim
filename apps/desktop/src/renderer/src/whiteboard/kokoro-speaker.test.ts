import { describe, expect, it, vi } from 'vitest'
import type { SpokenAudio, VoiceStatus } from '@codeswim/contract'
import { KokoroSpeaker, type AudioOut } from './kokoro-speaker'
import { WhiteboardSpeaker } from './speech'
import { VoiceSettings } from './voice'

const pcm = (n = 2400): SpokenAudio => ({ samples: new Float32Array(n), sampleRate: 24000 })

/** Plays each buffer for `ms`; records what played and in what order. */
function fakeAudio(ms = 5): AudioOut & { played: number[]; stopped: number } {
  const out = {
    state: 'running',
    destination: {} as AudioNode,
    played: [] as number[],
    stopped: 0,
    resume: async () => {},
    createBuffer: (_c: number, length: number) =>
      ({ length, copyToChannel: () => {} }) as unknown as AudioBuffer,
    createBufferSource: () => {
      const src = {
        buffer: null as AudioBuffer | null,
        onended: null as null | (() => void),
        connect: () => {},
        start: () => {
          out.played.push(src.buffer!.length)
          setTimeout(() => src.onended?.(), ms)
        },
        stop: () => {
          out.stopped++
        }
      }
      return src as unknown as AudioBufferSourceNode
    }
  }
  return out
}

interface SpeakerSetup {
  s: KokoroSpeaker
  audio: ReturnType<typeof fakeAudio>
  cancelRemote: ReturnType<typeof vi.fn>
  setVoice: (v: string) => string
}

function speaker(synth: (t: string) => Promise<SpokenAudio>, audio = fakeAudio()): SpeakerSetup {
  const cancelRemote = vi.fn()
  let voice = 'af_heart'
  const s = new KokoroSpeaker({ synth, cancelRemote, voiceKey: () => voice, audio: () => audio })
  return { s, audio, cancelRemote, setVoice: (v: string) => (voice = v) }
}

describe('KokoroSpeaker', () => {
  it('uses audio prepared ahead instead of synthesizing again', async () => {
    const synth = vi.fn(async (t: string) => pcm(t.length * 100))
    const { s, audio } = speaker(synth)
    s.prepare('One.')
    s.prepare('Two.')
    s.prepare('One.') // already queued
    const started: string[] = []
    await s.speak('One.', () => started.push('One.'))
    await s.speak('Two.', () => started.push('Two.'))
    expect(synth).toHaveBeenCalledTimes(2)
    expect(started).toEqual(['One.', 'Two.'])
    expect(audio.played).toEqual([400, 400])
  })

  it('keeps stock phrases across cancels and voices are cached separately', async () => {
    const synth = vi.fn(async () => pcm())
    const { s, setVoice } = speaker(synth)
    s.keep(['Let me show you.'])
    s.cancel()
    await s.speak('Let me show you.')
    expect(synth).toHaveBeenCalledTimes(1)
    setVoice('bf_emma')
    await s.speak('Let me show you.')
    expect(synth).toHaveBeenCalledTimes(2)
  })

  it('cancel stops playback, drops queued audio, and tells main', async () => {
    let release!: (a: SpokenAudio) => void
    const synth = vi.fn(() => new Promise<SpokenAudio>((r) => (release = r)))
    const { s, audio, cancelRemote } = speaker(synth)
    s.prepare('Slow sentence.')
    const speaking = s.speak('Slow sentence.')
    s.cancel()
    release(pcm())
    await speaking
    expect(audio.played).toEqual([])
    expect(cancelRemote).toHaveBeenCalled()
  })

  it('stops a sentence mid-playback', async () => {
    const { s, audio } = speaker(async () => pcm(), fakeAudio(10_000))
    const speaking = s.speak('Long sentence.')
    await vi.waitFor(() => expect(audio.played).toHaveLength(1))
    s.cancel()
    await speaking
    expect(audio.stopped).toBe(1)
  })

  it('surfaces a synthesis failure so the caller can fall back', async () => {
    const { s } = speaker(async () => {
      throw new Error('voice process stopped')
    })
    await expect(s.speak('Hi.')).rejects.toThrow('voice process stopped')
  })
})

describe('WhiteboardSpeaker with the natural voice', () => {
  it('prepares and speaks with Kokoro only while it is active and unmuted', async () => {
    const synth = vi.fn(async () => pcm())
    const { s } = speaker(synth)
    let active = false
    let muted = false
    const ws = new WhiteboardSpeaker(() => muted, { speaker: s, active: () => active })
    ws.prepare('Not yet.')
    expect(synth).not.toHaveBeenCalled()
    active = true
    ws.prepare('Now.')
    expect(synth).toHaveBeenCalledTimes(1)
    muted = true
    ws.prepare('Muted.')
    expect(synth).toHaveBeenCalledTimes(1)
  })

  it('falls back to captions/system for a sentence the natural voice fails on', async () => {
    const { s } = speaker(async () => {
      throw new Error('boom')
    })
    const log = vi.fn()
    const ws = new WhiteboardSpeaker(() => false, { speaker: s, active: () => true }, log)
    const onStart = vi.fn()
    // No speechSynthesis in Node, so the fallback is captions; it still starts and finishes.
    vi.useFakeTimers()
    const done = ws.speak('Still heard.', onStart)
    await vi.runAllTimersAsync()
    await done
    vi.useRealTimers()
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('natural voice failed'),
      expect.any(Error)
    )
  })
})

describe('VoiceSettings', () => {
  const status = (over: Partial<VoiceStatus>): VoiceStatus => ({
    available: true,
    installed: false,
    state: 'idle',
    progress: null,
    error: null,
    downloadMb: 163,
    ...over
  })

  interface FakeVoiceApi {
    push(s: VoiceStatus): void
    voiceStatus: ReturnType<typeof vi.fn<() => Promise<VoiceStatus>>>
    voiceInstall: ReturnType<typeof vi.fn<() => Promise<VoiceStatus>>>
    onVoiceStatus(cb: (s: VoiceStatus) => void): () => void
  }

  function api(initial: VoiceStatus): FakeVoiceApi {
    let push: (s: VoiceStatus) => void = () => {}
    return {
      push: (s: VoiceStatus) => push(s),
      voiceStatus: vi.fn(async () => initial),
      voiceInstall: vi.fn(async () => status({ installed: true, state: 'ready' })),
      onVoiceStatus: (cb: (s: VoiceStatus) => void) => {
        push = cb
        return () => {}
      }
    }
  }

  it('never downloads on its own, but loads a voice that is already on disk', async () => {
    const fresh = api(status({}))
    const a = new VoiceSettings(fresh)
    a.start()
    await vi.waitFor(() => expect(a.getSnapshot().status.available).toBe(true))
    expect(fresh.voiceInstall).not.toHaveBeenCalled()
    expect(a.naturalVoice).toBeNull()

    const onDisk = api(status({ installed: true }))
    const b = new VoiceSettings(onDisk)
    b.start()
    await vi.waitFor(() => expect(onDisk.voiceInstall).toHaveBeenCalled())
    await vi.waitFor(() => expect(b.naturalVoice).toBe('af_heart'))
  })

  it('follows status pushed from main, and the system preference turns it off', async () => {
    const a = api(status({}))
    const v = new VoiceSettings(a)
    v.start()
    a.push(status({ installed: true, state: 'ready' }))
    expect(v.naturalVoice).toBe('af_heart')
    v.setPreference({ kind: 'system' })
    expect(v.naturalVoice).toBeNull()
    v.setPreference({ kind: 'natural', voice: 'bf_emma' })
    expect(v.naturalVoice).toBe('bf_emma')
  })

  it('reports an install failure without the IPC noise', async () => {
    const a = api(status({}))
    a.voiceInstall.mockRejectedValueOnce(
      new Error("Error invoking remote method 'voice:install': Error: fetch failed")
    )
    const v = new VoiceSettings(a)
    await v.install()
    expect(v.getSnapshot().status).toMatchObject({ state: 'error', error: 'fetch failed' })
  })
})
