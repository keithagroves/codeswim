import { describe, expect, it, vi } from 'vitest'
import { parseHooksConfig, readHooksConfig, runSessionStartHooks, type HooksIo } from './hooks'

describe('parseHooksConfig', () => {
  it('returns empty config for malformed JSON', () => {
    expect(parseHooksConfig('not json')).toEqual({})
  })

  it('returns empty config when hooks field is missing', () => {
    expect(parseHooksConfig('{}')).toEqual({})
  })

  it('returns empty config when SessionStart is not an array', () => {
    expect(parseHooksConfig('{"hooks":{"SessionStart":"nope"}}')).toEqual({})
  })

  it('drops entries missing a non-empty command', () => {
    const raw = JSON.stringify({
      hooks: { SessionStart: [{}, { command: '' }, { command: '   ' }, { command: 'echo ok' }] }
    })
    expect(parseHooksConfig(raw)).toEqual({ hooks: { SessionStart: [{ command: 'echo ok' }] } })
  })

  it('keeps a valid numeric timeout and drops an invalid one', () => {
    const raw = JSON.stringify({
      hooks: {
        SessionStart: [
          { command: 'echo a', timeout: 1000 },
          { command: 'echo b', timeout: -1 },
          { command: 'echo c', timeout: 'soon' }
        ]
      }
    })
    expect(parseHooksConfig(raw)).toEqual({
      hooks: {
        SessionStart: [{ command: 'echo a', timeout: 1000 }, { command: 'echo b' }, { command: 'echo c' }]
      }
    })
  })
})

describe('readHooksConfig', () => {
  it('returns empty config when the file does not exist', async () => {
    const io: HooksIo = {
      readFile: vi.fn(async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }),
      exec: vi.fn()
    }
    expect(await readHooksConfig('/wt', io)).toEqual({})
  })

  it('reads and parses .codeswim/hooks.json under the workspace root', async () => {
    const readFile = vi.fn(async () => JSON.stringify({ hooks: { SessionStart: [{ command: 'echo hi' }] } }))
    const io: HooksIo = { readFile, exec: vi.fn() }
    expect(await readHooksConfig('/wt', io)).toEqual({ hooks: { SessionStart: [{ command: 'echo hi' }] } })
    expect(readFile).toHaveBeenCalledWith(expect.stringContaining('.codeswim'))
  })
})

describe('runSessionStartHooks', () => {
  it('returns an empty array when there are no hooks', async () => {
    const io: HooksIo = { readFile: vi.fn(), exec: vi.fn() }
    expect(await runSessionStartHooks({}, '/wt', io)).toEqual([])
  })

  it('collects trimmed stdout from successful hooks, in order', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: ' first \n' })
      .mockResolvedValueOnce({ code: 0, stdout: 'second' })
    const io: HooksIo = { readFile: vi.fn(), exec }
    const config = { hooks: { SessionStart: [{ command: 'a' }, { command: 'b' }] } }
    expect(await runSessionStartHooks(config, '/wt', io)).toEqual(['first', 'second'])
    expect(exec).toHaveBeenNthCalledWith(1, 'a', { cwd: '/wt', timeoutMs: 5000 })
  })

  it('uses a per-entry timeout override when present', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: 'ok' })
    const io: HooksIo = { readFile: vi.fn(), exec }
    const config = { hooks: { SessionStart: [{ command: 'a', timeout: 1234 }] } }
    await runSessionStartHooks(config, '/wt', io)
    expect(exec).toHaveBeenCalledWith('a', { cwd: '/wt', timeoutMs: 1234 })
  })

  it('skips a hook that exits non-zero without breaking the rest', async () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ code: 1, stdout: 'partial' })
      .mockResolvedValueOnce({ code: 0, stdout: 'good' })
    const io: HooksIo = { readFile: vi.fn(), exec }
    const config = { hooks: { SessionStart: [{ command: 'bad' }, { command: 'good' }] } }
    expect(await runSessionStartHooks(config, '/wt', io)).toEqual(['good'])
    expect(consoleErr).toHaveBeenCalled()
    consoleErr.mockRestore()
  })

  it('skips a hook whose exec rejects (e.g. timeout), without breaking the rest', async () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exec = vi
      .fn()
      .mockRejectedValueOnce(new Error('timed out'))
      .mockResolvedValueOnce({ code: 0, stdout: 'good' })
    const io: HooksIo = { readFile: vi.fn(), exec }
    const config = { hooks: { SessionStart: [{ command: 'slow' }, { command: 'good' }] } }
    expect(await runSessionStartHooks(config, '/wt', io)).toEqual(['good'])
    expect(consoleErr).toHaveBeenCalled()
    consoleErr.mockRestore()
  })

  it('drops empty stdout instead of appending a blank string', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: '   \n' })
    const io: HooksIo = { readFile: vi.fn(), exec }
    const config = { hooks: { SessionStart: [{ command: 'a' }] } }
    expect(await runSessionStartHooks(config, '/wt', io)).toEqual([])
  })
})
