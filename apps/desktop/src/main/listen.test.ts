import { describe, expect, it } from 'vitest'
import type { ListenStatus } from '@codeswim/contract'
import { ListenHost, type ListenWorkerHandle } from './listen'
import { runListenWorker, type ListenEngine } from './listen-worker-loop'
import type { FromListenWorker, ToListenWorker } from './listen-protocol'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** A worker handle wired straight to the real message loop and a fake engine. */
function inProcessWorker(engine: ListenEngine): ListenWorkerHandle & { exit(): void } {
  const toHost = new Set<(m: FromListenWorker) => void>()
  const exits = new Set<(code: number) => void>()
  let toWorker: (m: ToListenWorker) => void = () => {}
  runListenWorker(
    { post: (m) => toHost.forEach((h) => h(m)), onMessage: (h) => (toWorker = h) },
    engine
  )
  return {
    post: (m) => toWorker(m),
    onMessage: (h) => toHost.add(h),
    onExit: (h) => exits.add(h),
    kill: () => {},
    exit: () => exits.forEach((h) => h(1))
  }
}

function fakeEngine(opts: { failLoad?: boolean } = {}): ListenEngine & { heard: number[] } {
  const heard: number[] = []
  return {
    heard,
    async load(_dir, onProgress) {
      onProgress('config.json', 10, 10)
      onProgress('onnx/encoder_model_quantized.onnx', 50, 100)
      onProgress('onnx/decoder_model_merged_quantized.onnx', 0, 100)
      await tick()
      onProgress('onnx/encoder_model_quantized.onnx', 100, 100)
      onProgress('onnx/decoder_model_merged_quantized.onnx', 100, 100)
      if (opts.failLoad) throw new Error('network down')
    },
    async transcribe(samples) {
      heard.push(samples.length)
      await tick()
      if (samples[0] === -1) throw new Error('bad audio')
      return ` heard ${samples.length} `
    }
  }
}

interface Setup {
  host: ListenHost
  statuses: ListenStatus[]
  engine: ReturnType<typeof fakeEngine>
  worker: () => ReturnType<typeof inProcessWorker>
}

function setup(engine = fakeEngine(), installed = false): Setup {
  const statuses: ListenStatus[] = []
  let worker!: ReturnType<typeof inProcessWorker>
  const host = new ListenHost({
    cacheDir: '/data/whisper',
    exists: () => installed,
    notify: (s) => statuses.push(s),
    spawn: () => (worker = inProcessWorker(engine))
  })
  return { host, statuses, engine, worker: () => worker }
}

describe('ListenHost', () => {
  it('downloads, then loads, then transcribes in order', async () => {
    const { host, statuses, engine } = setup()
    expect(host.status()).toMatchObject({ installed: false, state: 'idle', downloadMb: 77 })
    await host.install()
    const states = statuses.map((s) => s.state)
    expect(states[0]).toBe('downloading')
    expect(states).toContain('loading')
    expect(states.at(-1)).toBe('ready')
    expect(statuses.some((s) => s.progress !== null && s.progress > 0 && s.progress < 1)).toBe(true)
    const texts = await Promise.all([
      host.transcribe(new Float32Array(16000)),
      host.transcribe(new Float32Array(8000))
    ])
    expect(texts).toEqual([' heard 16000 ', ' heard 8000 '])
    expect(engine.heard).toEqual([16000, 8000])
  })

  it('caps an utterance at 30 seconds', async () => {
    const { host, engine } = setup()
    await host.install()
    await host.transcribe(new Float32Array(16000 * 45))
    expect(engine.heard).toEqual([16000 * 30])
  })

  it('loads the model shipped with the app, without downloading', async () => {
    const statuses: ListenStatus[] = []
    let dirs: (string | undefined)[] = []
    const engine = fakeEngine()
    const host = new ListenHost({
      cacheDir: '/data/whisper',
      bundledDir: '/app/models',
      exists: (f) => f.startsWith('/app/models/onnx-community/whisper-base.en/onnx/'),
      notify: (s) => statuses.push(s),
      spawn: () =>
        inProcessWorker({
          ...engine,
          load: (cacheDir, _onProgress, modelDir) => {
            dirs = [cacheDir, modelDir]
            return Promise.resolve()
          }
        })
    })
    expect(host.status().installed).toBe(true)
    await host.install()
    expect(statuses.map((s) => s.state)).toEqual(['loading', 'ready'])
    expect(dirs).toEqual(['/data/whisper', '/app/models'])
  })

  it('skips the download state when the model is already on disk', async () => {
    const { host, statuses } = setup(fakeEngine(), true)
    await host.install()
    expect(statuses[0].state).toBe('loading')
  })

  it('reports a failed install', async () => {
    const { host } = setup(fakeEngine({ failLoad: true }))
    await expect(host.install()).rejects.toThrow('network down')
    expect(host.status()).toMatchObject({ state: 'error', error: 'network down' })
  })

  it('refuses to transcribe before the model is loaded', async () => {
    const { host } = setup()
    await expect(host.transcribe(new Float32Array(10))).rejects.toThrow(/not loaded/)
  })

  it('rejects one bad utterance without stopping the next', async () => {
    const { host } = setup()
    await host.install()
    const bad = new Float32Array(4).fill(-1)
    const [a, b] = await Promise.allSettled([
      host.transcribe(bad),
      host.transcribe(new Float32Array(4))
    ])
    expect(a).toMatchObject({ status: 'rejected', reason: new Error('bad audio') })
    expect(b).toMatchObject({ status: 'fulfilled', value: ' heard 4 ' })
  })

  it('rejects pending utterances if the speech process dies', async () => {
    const { host, worker } = setup()
    await host.install()
    const pending = host.transcribe(new Float32Array(10)).catch((e: Error) => e)
    worker().exit()
    expect(await pending).toEqual(new Error('The speech process stopped.'))
    expect(host.status().state).toBe('idle')
  })
})
