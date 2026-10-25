import { describe, expect, it } from 'vitest'
import type { VoiceStatus } from '@codeswim/contract'
import { isVoiceId, VoiceHost, type VoiceWorkerHandle } from './voice'
import { runVoiceWorker, type VoiceEngine } from './voice-worker-loop'
import type { FromVoiceWorker, ToVoiceWorker } from './voice-protocol'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** A worker handle wired straight to the real message loop and a fake engine. */
function inProcessWorker(
  engine: VoiceEngine
): VoiceWorkerHandle & { exit(): void; sent: ToVoiceWorker[] } {
  const toHost = new Set<(m: FromVoiceWorker) => void>()
  const exits = new Set<(code: number) => void>()
  let toWorker: (m: ToVoiceWorker) => void = () => {}
  const sent: ToVoiceWorker[] = []
  runVoiceWorker(
    { post: (m) => toHost.forEach((h) => h(m)), onMessage: (h) => (toWorker = h) },
    engine
  )
  return {
    sent,
    post: (m) => {
      sent.push(m)
      toWorker(m)
    },
    onMessage: (h) => toHost.add(h),
    onExit: (h) => exits.add(h),
    kill: () => {},
    exit: () => exits.forEach((h) => h(1))
  }
}

function fakeEngine(opts: { failLoad?: boolean } = {}): VoiceEngine & { spoken: string[] } {
  const spoken: string[] = []
  return {
    spoken,
    async load(_dir, onProgress) {
      onProgress('config.json', 10, 10)
      onProgress('onnx/model_fp16.onnx', 50, 100)
      await tick()
      onProgress('onnx/model_fp16.onnx', 100, 100)
      if (opts.failLoad) throw new Error('network down')
    },
    async generate(text) {
      spoken.push(text)
      await tick()
      return { samples: new Float32Array(text.length * 10), sampleRate: 24000 }
    }
  }
}

interface Setup {
  host: VoiceHost
  statuses: VoiceStatus[]
  engine: ReturnType<typeof fakeEngine>
  worker: () => ReturnType<typeof inProcessWorker>
}

function setup(engine = fakeEngine(), installed = false): Setup {
  const statuses: VoiceStatus[] = []
  let worker!: ReturnType<typeof inProcessWorker>
  const host = new VoiceHost({
    cacheDir: '/data/kokoro',
    exists: () => installed,
    notify: (s) => statuses.push(s),
    spawn: () => (worker = inProcessWorker(engine))
  })
  return { host, statuses, engine, worker: () => worker }
}

describe('VoiceHost', () => {
  it('downloads, then loads, then speaks', async () => {
    const { host, statuses, engine } = setup()
    expect(host.status()).toMatchObject({
      available: true,
      installed: false,
      state: 'idle',
      downloadMb: 163
    })
    await host.install()
    const states = statuses.map((s) => s.state)
    expect(states[0]).toBe('downloading')
    expect(states).toContain('loading')
    expect(states.at(-1)).toBe('ready')
    expect(statuses.some((s) => s.progress !== null && s.progress > 0 && s.progress < 1)).toBe(true)
    expect(host.status()).toMatchObject({ installed: true, state: 'ready', progress: null })
    const audio = await host.speak('Hello there.', 'af_heart')
    expect(audio.sampleRate).toBe(24000)
    expect(audio.samples.length).toBe('Hello there.'.length * 10)
    expect(engine.spoken).toEqual(['Hello there.'])
  })

  it('loads the model shipped with the app, without downloading', async () => {
    const statuses: VoiceStatus[] = []
    let worker!: ReturnType<typeof inProcessWorker>
    const host = new VoiceHost({
      cacheDir: '/data/kokoro',
      bundledDir: '/app/models',
      exists: (f) => f.startsWith('/app/models/onnx-community/Kokoro-82M-v1.0-ONNX/onnx/'),
      notify: (s) => statuses.push(s),
      spawn: () => (worker = inProcessWorker(fakeEngine()))
    })
    expect(host.status().installed).toBe(true)
    await host.install()
    expect(statuses.map((s) => s.state)).not.toContain('downloading')
    expect(worker.sent[0]).toEqual({
      type: 'load',
      cacheDir: '/data/kokoro',
      modelDir: '/app/models'
    })
  })

  it('downloads when the app has no models with it', async () => {
    const { host, worker } = setup()
    await host.install()
    expect(worker().sent[0]).toEqual({ type: 'load', cacheDir: '/data/kokoro' })
  })

  it('skips the download state when the model is already on disk', async () => {
    const { host, statuses } = setup(fakeEngine(), true)
    await host.install()
    expect(statuses[0].state).toBe('loading')
  })

  it('shares one install between callers', async () => {
    const { host } = setup()
    const a = host.install()
    const b = host.install()
    expect(a).toBe(b)
    await a
  })

  it('reports a failed install and can retry', async () => {
    const { host } = setup(fakeEngine({ failLoad: true }))
    await expect(host.install()).rejects.toThrow('network down')
    expect(host.status()).toMatchObject({ state: 'error', error: 'network down' })
  })

  it('refuses to speak before the voice is loaded', async () => {
    const { host } = setup()
    await expect(host.speak('Hi.', 'af_heart')).rejects.toThrow(/not loaded/)
  })

  it('cancel drops sentences that have not started', async () => {
    const { host, engine } = setup()
    await host.install()
    const results = Promise.allSettled([
      host.speak('One.', 'af_heart'),
      host.speak('Two.', 'af_heart'),
      host.speak('Three.', 'af_heart')
    ])
    host.cancel()
    const [first, second, third] = await results
    expect(first).toMatchObject({ status: 'fulfilled', value: { sampleRate: 24000 } })
    expect(second).toMatchObject({ status: 'rejected', reason: new Error('cancelled') })
    expect(third).toMatchObject({ status: 'rejected', reason: new Error('cancelled') })
    expect(engine.spoken).toEqual(['One.'])
  })

  it('renders background phrases behind real sentences', async () => {
    const { host, engine } = setup()
    await host.install()
    await Promise.all([
      host.speak('Stock one.', 'af_heart', 1, true),
      host.speak('Stock two.', 'af_heart', 1, true),
      host.speak('Real sentence.', 'af_heart')
    ])
    // "Stock one." had already started; the real sentence jumped "Stock two.".
    expect(engine.spoken).toEqual(['Stock one.', 'Real sentence.', 'Stock two.'])
  })

  it('cancel keeps background phrases', async () => {
    const { host } = setup()
    await host.install()
    const results = Promise.allSettled([
      host.speak('Real one.', 'af_heart'),
      host.speak('Stock.', 'af_heart', 1, true),
      host.speak('Real two.', 'af_heart')
    ])
    host.cancel()
    expect((await results).map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'rejected'])
  })

  it('rejects pending sentences if the voice process dies', async () => {
    const { host, worker } = setup()
    await host.install()
    const pending = host.speak('Never finished.', 'af_heart').catch((e: Error) => e)
    worker().exit()
    expect(await pending).toEqual(new Error('The voice process stopped.'))
    expect(host.status().state).toBe('idle')
  })

  it('validates voice ids', () => {
    expect(isVoiceId('af_heart')).toBe(true)
    expect(isVoiceId('af_nicole')).toBe(false)
    expect(isVoiceId(42)).toBe(false)
  })
})
