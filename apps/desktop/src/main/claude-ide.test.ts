// Drives ClaudeIdeBridge over a real WebSocket the way the `claude` CLI does:
// lockfile discovery, the auth header, MCP initialize/tools, and the blocking
// openDiff round-trip.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import type { ClaudeIdeDiff } from '@codeswim/contract'
import { ClaudeIdeBridge, matchRange, type ClaudeIdeHost } from './claude-ide'

type Sent = { channel: string; payload: unknown }

let dir: string
let root: string
let sent: Sent[]
let bridge: ClaudeIdeBridge

function connect(token: string | undefined): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.getPort()}`, {
      headers: token ? { 'x-claude-code-ide-authorization': token } : {}
    })
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

// Just the parts of a JSON-RPC response these tests read.
interface RpcResponse {
  result?: {
    content?: Array<{ text: string }>
    serverInfo?: unknown
    tools?: Array<{ name: string }>
  }
  error?: { code: number }
}

interface RpcClient {
  notes: Array<{ method: string; params: unknown }>
  call(method: string, params?: unknown): Promise<RpcResponse>
  notify(method: string, params?: unknown): void
}

function rpc(ws: WebSocket): RpcClient {
  let next = 1
  const waiting = new Map<number, (v: unknown) => void>()
  const notes: Array<{ method: string; params: unknown }> = []
  ws.on('message', (d) => {
    const m = JSON.parse(String(d))
    if (m.id !== undefined) waiting.get(m.id)?.(m)
    else notes.push(m)
  })
  return {
    notes,
    call(method: string, params?: unknown): Promise<RpcResponse> {
      const id = next++
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      return new Promise((r) => waiting.set(id, r as (v: unknown) => void))
    },
    notify(method: string, params?: unknown): void {
      ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
    }
  }
}

const tool = (
  name: string,
  args: Record<string, unknown> = {}
): { name: string; arguments: Record<string, unknown> } => ({ name, arguments: args })
const texts = (r: RpcResponse): string[] => (r.result?.content ?? []).map((c) => c.text)

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'claude-ide-'))
  root = join(dir, 'ws')
  mkdirSync(root)
  writeFileSync(join(root, 'a.ts'), 'one\ntwo\nthree\nfour\n')
  sent = []
  const host = {
    version: '9.9.9',
    send: (channel: string, payload: unknown) => sent.push({ channel, payload })
  } as ClaudeIdeHost
  bridge = new ClaudeIdeBridge(host, join(dir, 'claude'))
  await bridge.setWorkspace(root)
  await bridge.activate()
})

afterEach(() => {
  bridge.stop()
  rmSync(dir, { recursive: true, force: true })
})

function lock(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'claude', 'ide', `${bridge.getPort()}.lock`), 'utf8'))
}

describe('ClaudeIdeBridge', () => {
  it('publishes no lockfile until the Claude tab activates it', async () => {
    const idle = new ClaudeIdeBridge(
      { version: 'x', send: () => {} } as ClaudeIdeHost,
      join(dir, 'idle-claude')
    )
    await idle.setWorkspace(root)
    expect(existsSync(join(dir, 'idle-claude', 'ide'))).toBe(false)
    await idle.activate()
    expect(existsSync(join(dir, 'idle-claude', 'ide', `${idle.getPort()}.lock`))).toBe(true)
    idle.stop()
  })

  it('writes an owner-only lockfile the CLI can discover', () => {
    const l = lock()
    expect(l).toMatchObject({
      pid: process.pid,
      workspaceFolders: [root],
      ideName: 'Codeswim',
      transport: 'ws'
    })
    expect(typeof l.authToken).toBe('string')
    const mode = statSync(join(dir, 'claude', 'ide', `${bridge.getPort()}.lock`)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('points the CLI at this server and skips the VS Code extension install', () => {
    const env = bridge.claudeEnv({
      TERM_PROGRAM: 'vscode',
      TERM_PROGRAM_VERSION: '1',
      PATH: '/bin'
    })
    expect(env.CLAUDE_CODE_SSE_PORT).toBe(String(bridge.getPort()))
    expect(env.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL).toBe('1')
    expect(env.TERM_PROGRAM).toBeUndefined()
    expect(env.PATH).toBe('/bin')
  })

  it('rejects connections without the auth token', async () => {
    const ws = await connect('wrong')
    const code = await new Promise((r) => ws.once('close', (c) => r(c)))
    expect(code).toBe(1008)
  })

  it('speaks MCP: initialize and tools/list', async () => {
    const c = rpc(await connect(lock().authToken as string))
    const init = await c.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} })
    expect(init.result?.serverInfo).toEqual({ name: 'codeswim', version: '9.9.9' })
    const list = await c.call('tools/list')
    const names = (list.result?.tools ?? []).map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining(['openDiff', 'close_tab', 'getDiagnostics', 'openFile'])
    )
    expect((await c.call('bogus')).error?.code).toBe(-32601)
  })

  it('openDiff blocks until accepted and returns the proposed contents', async () => {
    const c = rpc(await connect(lock().authToken as string))
    const pending = c.call(
      'tools/call',
      tool('openDiff', {
        old_file_path: join(root, 'a.ts'),
        new_file_path: join(root, 'a.ts'),
        new_file_contents: 'one\nTWO\nthree\nfour\n',
        tab_name: '✻ [Claude Code] a.ts'
      })
    )
    await new Promise((r) => setTimeout(r, 50))
    const shown = sent.find((s) => s.channel === 'claude-ide:show-diff')?.payload as ClaudeIdeDiff
    expect(shown.relPath).toBe('a.ts')
    expect(shown.diff).toContain('-two')
    expect(shown.diff).toContain('+TWO')
    bridge.resolveDiff('✻ [Claude Code] a.ts', true)
    expect(texts(await pending)).toEqual(['FILE_SAVED', 'one\nTWO\nthree\nfour\n'])
  })

  it('close_tab (answered in the terminal) settles the diff as rejected', async () => {
    const c = rpc(await connect(lock().authToken as string))
    const pending = c.call(
      'tools/call',
      tool('openDiff', {
        old_file_path: join(root, 'new.ts'),
        new_file_path: join(root, 'new.ts'),
        new_file_contents: 'hi\n',
        tab_name: 'tab-1'
      })
    )
    await new Promise((r) => setTimeout(r, 50))
    expect(texts(await c.call('tools/call', tool('close_tab', { tab_name: 'tab-1' })))).toEqual([
      'TAB_CLOSED'
    ])
    expect(texts(await pending)).toEqual(['DIFF_REJECTED', 'tab-1'])
    expect(sent.some((s) => s.channel === 'claude-ide:close-diff' && s.payload === 'tab-1')).toBe(
      true
    )
  })

  it('reports selection and pushes selection_changed', async () => {
    const c = rpc(await connect(lock().authToken as string))
    expect(
      JSON.parse(texts(await c.call('tools/call', tool('getCurrentSelection')))[0]).success
    ).toBe(false)
    const selection = {
      start: { line: 1, character: 0 },
      end: { line: 1, character: 3 },
      isEmpty: false
    }
    bridge.reportEditor({ filePath: join(root, 'a.ts'), selection, text: 'two' })
    const cur = JSON.parse(texts(await c.call('tools/call', tool('getCurrentSelection')))[0])
    expect(cur).toMatchObject({
      success: true,
      text: 'two',
      filePath: join(root, 'a.ts'),
      selection
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(c.notes.find((n) => n.method === 'selection_changed')?.params).toMatchObject({
      text: 'two'
    })
  })

  it('openFile resolves a text match to a line range inside the workspace only', async () => {
    const c = rpc(await connect(lock().authToken as string))
    await c.call(
      'tools/call',
      tool('openFile', { filePath: 'a.ts', startText: 'two', endText: 'three' })
    )
    expect(sent.find((s) => s.channel === 'claude-ide:open-file')?.payload).toEqual({
      relPath: 'a.ts',
      range: { start: 2, end: 3 }
    })
    const outside = JSON.parse(
      texts(await c.call('tools/call', tool('openFile', { filePath: '/etc/hosts' })))[0]
    )
    expect(outside.success).toBe(false)
  })

  it('removes the lockfile when the workspace closes', async () => {
    const p = join(dir, 'claude', 'ide', `${bridge.getPort()}.lock`)
    await bridge.setWorkspace(null)
    expect(existsSync(p)).toBe(false)
  })
})

describe('matchRange', () => {
  it('spans startText through endText', () => {
    expect(matchRange('a\nb\nc\nd', 'b', 'c')).toEqual({ start: 2, end: 3 })
    expect(matchRange('a\nb', 'zzz', undefined)).toBeNull()
    expect(matchRange('a\nb\nc', 'c', undefined)).toEqual({ start: 3, end: 3 })
  })
})
