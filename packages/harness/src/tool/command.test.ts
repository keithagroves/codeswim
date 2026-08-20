import { describe, expect, it, vi } from 'vitest'
import {
  findCommand,
  formatCommandList,
  resolveCommandConfig,
  runCommand,
  type CommandConfig,
  type CommandIo
} from './command'

const config: CommandConfig = { url: 'http://127.0.0.1:5173', token: 'cap-token' }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('resolveCommandConfig', () => {
  it('returns null when either var is missing', () => {
    expect(resolveCommandConfig({})).toBeNull()
    expect(resolveCommandConfig({ CODESWIM_COMMAND_URL: 'http://x' })).toBeNull()
    expect(resolveCommandConfig({ CODESWIM_COMMAND_TOKEN: 't' })).toBeNull()
  })

  it('builds a config from both env vars', () => {
    expect(
      resolveCommandConfig({ CODESWIM_COMMAND_URL: 'http://127.0.0.1:1', CODESWIM_COMMAND_TOKEN: 'tok' })
    ).toEqual({ url: 'http://127.0.0.1:1', token: 'tok' })
  })
})

describe('findCommand', () => {
  it('sends session/worktree/query and unwraps the commands array', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ commands: [{ id: 'nav.openFile' }] }))
    const io: CommandIo = { fetch: fetchFn }

    const result = await findCommand('open', 's1', '/wt', config, io)
    expect(result).toEqual({ ok: true, value: [{ id: 'nav.openFile' }] })

    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:5173/find')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toMatchObject({ authorization: 'Bearer cap-token' })
    expect(JSON.parse(init?.body as string)).toEqual({ sessionId: 's1', worktree: '/wt', query: 'open' })
  })

  it('surfaces a network failure as a result, not a throw', async () => {
    const io: CommandIo = {
      fetch: vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      })
    }
    const result = await findCommand('open', 's1', '/wt', config, io)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toMatch(/could not reach the app/)
  })

  it('surfaces a non-2xx status as an error', async () => {
    const io: CommandIo = { fetch: vi.fn(async () => jsonResponse({ message: 'invalid token' }, 401)) }
    const result = await findCommand('open', 's1', '/wt', config, io)
    expect(result).toEqual({ ok: false, error: 'invalid token' })
  })

  it('falls back to a status-only message when the body has no message field', async () => {
    const io: CommandIo = { fetch: vi.fn(async () => new Response('', { status: 503 })) }
    const result = await findCommand('open', 's1', '/wt', config, io)
    expect(result).toEqual({ ok: false, error: 'request failed (503)' })
  })
})

describe('runCommand', () => {
  it('sends session/worktree/id/args and unwraps a successful outcome', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ ok: true, value: 'done' }))
    const io: CommandIo = { fetch: fetchFn }

    const result = await runCommand('nav.openFile', { relPath: 'a.md' }, 's1', '/wt', config, io)
    expect(result).toEqual({ ok: true, value: 'done' })

    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:5173/run')
    expect(JSON.parse(init?.body as string)).toEqual({
      sessionId: 's1',
      worktree: '/wt',
      id: 'nav.openFile',
      args: { relPath: 'a.md' }
    })
  })

  it('surfaces a policy-rejected outcome (200 response, ok:false body) as an error', async () => {
    const io: CommandIo = {
      fetch: vi.fn(async () => jsonResponse({ ok: false, code: 'forbidden-origin', message: 'nope' }))
    }
    const result = await runCommand('nav.popTo', { index: 0 }, 's1', '/wt', config, io)
    expect(result).toEqual({ ok: false, error: 'nope' })
  })
})

describe('formatCommandList', () => {
  it('reports no matches', () => {
    expect(formatCommandList([])).toBe('No commands matched.')
  })

  it('lists id + description per line', () => {
    const out = formatCommandList([
      { id: 'nav.openFile', domain: 'nav', title: 'Open', description: 'Opens a file', schema: {}, agent: 'listed' }
    ])
    expect(out).toBe('- nav.openFile: Opens a file')
  })
})
