import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { BrowserWindow } from 'electron'
import { CommandServer, type CommandRendererRequest } from './command-server'

const execFileAsync = promisify(execFile)

// A fake BrowserWindow whose webContents.send is hookable, so tests can
// simulate the renderer's reply without any real IPC/Electron runtime.
function fakeWindow(onSend: (request: CommandRendererRequest) => void): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (_channel: string, request: CommandRendererRequest) => onSend(request)
    }
  } as unknown as BrowserWindow
}

const servers: CommandServer[] = []
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

async function repo(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'codeswim-cmdsrv-'))
  dirs.push(d)
  await execFileAsync('git', ['init', '-q'], { cwd: d })
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: d })
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: d })
  await fs.writeFile(path.join(d, 'README.md'), 'hi\n', 'utf-8')
  await execFileAsync('git', ['add', '-A'], { cwd: d })
  await execFileAsync('git', ['commit', '-q', '-m', 'initial'], { cwd: d })
  return d
}

// Starts a server bound to `root`, with `onSend` standing in for the
// renderer's reply. Returns the capability so tests can build requests.
async function start(
  root: string,
  onSend: (request: CommandRendererRequest) => void
): Promise<{ server: CommandServer; cap: { url: string; token: string } }> {
  const server = new CommandServer(() => fakeWindow(onSend), 200)
  servers.push(server)
  const cap = await server.issueCapability(root)
  return { server, cap }
}

function post(url: string, token: string | null, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  })
}

describe('CommandServer auth + routing', () => {
  it('rejects a request with no token', async () => {
    const root = await repo()
    const { cap } = await start(root, () => {})
    const res = await post(`${cap.url}/find`, null, { sessionId: 's', worktree: root, query: '' })
    expect(res.status).toBe(401)
  })

  it('rejects a request with the wrong token', async () => {
    const root = await repo()
    const { cap } = await start(root, () => {})
    const res = await post(`${cap.url}/find`, 'wrong-token', { sessionId: 's', worktree: root, query: '' })
    expect(res.status).toBe(401)
  })

  it('rejects an unknown route and non-POST methods', async () => {
    const root = await repo()
    const { cap } = await start(root, () => {})
    expect((await post(`${cap.url}/other`, cap.token, {})).status).toBe(404)
    expect((await fetch(`${cap.url}/find`, { method: 'GET' })).status).toBe(404)
  })

  it('rejects a body over the size cap', async () => {
    const root = await repo()
    const { cap } = await start(root, () => {})
    const huge = 'x'.repeat(70 * 1024)
    const res = await post(`${cap.url}/find`, cap.token, { sessionId: 's', worktree: root, query: huge })
    expect(res.status).toBe(400)
  })

  it('rejects malformed JSON', async () => {
    const root = await repo()
    const { cap } = await start(root, () => {})
    const res = await fetch(`${cap.url}/find`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cap.token}` },
      body: '{not json'
    })
    expect(res.status).toBe(400)
  })

  it('rejects a request missing sessionId or worktree', async () => {
    const root = await repo()
    const { cap } = await start(root, () => {})
    expect((await post(`${cap.url}/find`, cap.token, { worktree: root, query: '' })).status).toBe(400)
    expect((await post(`${cap.url}/find`, cap.token, { sessionId: 's', query: '' })).status).toBe(400)
  })

  it('a previous token stops working once a new capability is issued', async () => {
    const root = await repo()
    const { server, cap } = await start(root, () => {})
    await server.issueCapability(root)
    const res = await post(`${cap.url}/find`, cap.token, { sessionId: 's', worktree: root, query: '' })
    expect(res.status).toBe(401)
  })

  it('rejects everything once revoked', async () => {
    const root = await repo()
    const { server, cap } = await start(root, () => {})
    server.revoke()
    const res = await post(`${cap.url}/find`, cap.token, { sessionId: 's', worktree: root, query: '' })
    expect(res.status).toBe(401)
  })
})

describe('CommandServer worktree validation', () => {
  it('accepts the bound workspace root itself', async () => {
    const root = await repo()
    const { cap } = await start(root, (req) => {
      expect(req.kind).toBe('find')
    })
    const res = await post(`${cap.url}/find`, cap.token, { sessionId: 's', worktree: root, query: '' })
    // No renderer reply arrives (onSend doesn't call back), so this times
    // out — the point here is confirming it got PAST worktree validation,
    // which a 403 vs 504 status distinguishes.
    expect(res.status).toBe(504)
  })

  it('rejects a worktree that does not exist on disk', async () => {
    const root = await repo()
    const { cap } = await start(root, () => {})
    const res = await post(`${cap.url}/find`, cap.token, {
      sessionId: 's',
      worktree: path.join(root, 'not-a-real-dir'),
      query: ''
    })
    expect(res.status).toBe(403)
  })

  it('accepts a real git worktree of the bound root', async () => {
    const root = await repo()
    const worktreePath = path.join(os.tmpdir(), `codeswim-cmdsrv-wt-${Date.now()}`)
    dirs.push(worktreePath)
    await execFileAsync('git', ['worktree', 'add', '-b', 'codeswim/task-1', worktreePath, 'HEAD'], {
      cwd: root
    })
    const { cap } = await start(root, () => {})
    const res = await post(`${cap.url}/find`, cap.token, { sessionId: 's', worktree: worktreePath, query: '' })
    // Times out waiting on the renderer, same reasoning as above — proves it
    // cleared worktree validation rather than failing with 403.
    expect(res.status).toBe(504)
  })
})

describe('CommandServer request/reply proxying', () => {
  it('round-trips a find request through the renderer callback', async () => {
    const root = await repo()
    const { server, cap } = await start(root, (req) => {
      expect(req.kind).toBe('find')
      if (req.kind === 'find') {
        server.resolveReply({
          id: req.id,
          kind: 'find',
          commands: [{ id: 'nav.openFile', domain: 'nav', title: 'x', description: 'y', schema: {}, agent: 'listed' }]
        })
      }
    })
    const res = await post(`${cap.url}/find`, cap.token, { sessionId: 's', worktree: root, query: 'open' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.commands).toHaveLength(1)
  })

  it('round-trips a run request, forwarding sessionId/worktree as the origin', async () => {
    const root = await repo()
    const { server, cap } = await start(root, (req) => {
      expect(req.kind).toBe('run')
      if (req.kind === 'run') {
        expect(req.origin).toEqual({ kind: 'agent', sessionId: 's1', worktree: root })
        expect(req.commandId).toBe('nav.setWorkspaceView')
        expect(req.args).toEqual({ view: 'kanban' })
        server.resolveReply({ id: req.id, kind: 'run', outcome: { ok: true, value: undefined } })
      }
    })
    const res = await post(`${cap.url}/run`, cap.token, {
      sessionId: 's1',
      worktree: root,
      id: 'nav.setWorkspaceView',
      args: { view: 'kanban' }
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, value: undefined })
  })

  it('maps a forbidden-origin outcome to 403 and a handler-error to 500', async () => {
    const root = await repo()
    let call = 0
    const { server, cap } = await start(root, (req) => {
      if (req.kind !== 'run') return
      call += 1
      const outcome =
        call === 1
          ? { ok: false as const, code: 'forbidden-origin' as const, message: 'nope' }
          : { ok: false as const, code: 'handler-error' as const, message: 'boom' }
      server.resolveReply({ id: req.id, kind: 'run', outcome })
    })
    const first = await post(`${cap.url}/run`, cap.token, { sessionId: 's', worktree: root, id: 'a', args: {} })
    expect(first.status).toBe(403)
    const second = await post(`${cap.url}/run`, cap.token, { sessionId: 's', worktree: root, id: 'b', args: {} })
    expect(second.status).toBe(500)
  })

  it('returns 503 immediately when there is no renderer window', async () => {
    const root = await repo()
    const server = new CommandServer(() => null, 200)
    servers.push(server)
    const cap = await server.issueCapability(root)
    const res = await post(`${cap.url}/find`, cap.token, { sessionId: 's', worktree: root, query: '' })
    expect(res.status).toBe(503)
  })

  it('returns 504 and clears the pending entry when the renderer never replies', async () => {
    const root = await repo()
    const { server, cap } = await start(root, () => {
      // never replies
    })
    const res = await post(`${cap.url}/find`, cap.token, { sessionId: 's', worktree: root, query: '' })
    expect(res.status).toBe(504)
    // A reply arriving after the timeout (for whatever id) must not throw or
    // resurrect a settled request.
    expect(() => server.resolveReply({ id: 'stale', kind: 'find', commands: [] })).not.toThrow()
  })

  it('matches concurrent requests to their own reply by correlation id, even out of order', async () => {
    const root = await repo()
    const seen: CommandRendererRequest[] = []
    const { server, cap } = await start(root, (req) => seen.push(req))

    const first = post(`${cap.url}/find`, cap.token, { sessionId: 's', worktree: root, query: 'a' })
    const second = post(`${cap.url}/find`, cap.token, { sessionId: 's', worktree: root, query: 'b' })
    await vi.waitFor(() => expect(seen).toHaveLength(2))

    // Reply to the second request first.
    const [reqA, reqB] = seen
    server.resolveReply({ id: reqB.id, kind: 'find', commands: [{ id: 'b', domain: '', title: '', description: '', schema: {}, agent: 'listed' }] })
    server.resolveReply({ id: reqA.id, kind: 'find', commands: [{ id: 'a', domain: '', title: '', description: '', schema: {}, agent: 'listed' }] })

    const [resFirst, resSecond] = await Promise.all([first, second])
    expect((await resFirst.json()).commands[0].id).toBe('a')
    expect((await resSecond.json()).commands[0].id).toBe('b')
  })
})
