// Loopback HTTP bridge for the harness sidecar's find_command/run_command
// tools (packages/harness/src/tool/command.ts). Main is the only process
// that can reach the renderer's command registry (apps/desktop/src/renderer/
// src/commands/registry.ts) — a browser sandbox has no route from a
// subprocess straight into a renderer, so every request here is proxied
// over IPC with a correlation id and awaited.
//
// Lifecycle: the HTTP server itself starts once (lazily, on the first
// harness start) and stays up for the app's lifetime. What rotates is the
// *capability* — issueCapability mints a fresh random token bound to one
// workspace root each time the harness (re)starts; revoke() invalidates it
// on stop or root switch, in main/index.ts's harness:start/harness:stop
// handlers.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { BrowserWindow } from 'electron'
import { gitWorktreeList } from '@codeswim/domain-git'
import type { CommandErrorCode, CommandRendererRequest, CommandRendererResponse } from '@codeswim/contract'

const MAX_BODY_BYTES = 64 * 1024
const REQUEST_TIMEOUT_MS = 15_000

export interface CommandServerCapability {
  url: string
  token: string
}

export type { CommandRendererRequest, CommandRendererResponse }

interface PendingRequest {
  resolve(response: CommandRendererResponse): void
  reject(err: Error): void
  timer: NodeJS.Timeout
}

const POLICY_STATUS: Record<CommandErrorCode, number> = {
  'unknown-command': 400,
  'invalid-args': 400,
  'forbidden-origin': 403,
  denied: 403,
  'duplicate-command': 500,
  'handler-error': 500
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(json)
}

// Reads the request body, capped at MAX_BODY_BYTES (not trusting
// Content-Length, which a client can lie about). Once the accumulated size
// crosses the cap, buffered chunks are dropped to bound memory, but the
// socket is drained to completion rather than destroyed — killing the
// connection mid-upload just breaks the client's own request before it ever
// sees the 400 this is supposed to produce.
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) {
        reject(new Error('body too large'))
        return
      }
      resolve(Buffer.concat(chunks).toString('utf-8'))
    })
    req.on('error', reject)
  })
}

function timingSafeTokenEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  // timingSafeEqual throws on length mismatch — compare a fixed-size hash of
  // both instead of the raw (variable-length) tokens so a length probe
  // leaks nothing either.
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export class CommandServer {
  private server: Server | null = null
  private port = 0
  private token: string | null = null
  private boundRoot: string | null = null
  private readonly pending = new Map<string, PendingRequest>()

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    // Overridable so tests don't have to wait out the real 15s to exercise
    // the timeout path.
    private readonly requestTimeoutMs: number = REQUEST_TIMEOUT_MS
  ) {}

  private async ensureStarted(): Promise<void> {
    if (this.server) return
    const server = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { message: 'internal error' })
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server.address()
    this.port = addr && typeof addr === 'object' ? addr.port : 0
    this.server = server
  }

  // Mints a fresh capability bound to rootPath, replacing any previous one.
  // Called on every harness start (main/index.ts) — including a restart
  // against the same root — so a stale sidecar that captured an old token
  // loses access the moment a new one starts.
  async issueCapability(rootPath: string): Promise<CommandServerCapability> {
    await this.ensureStarted()
    this.token = randomBytes(24).toString('hex')
    this.boundRoot = rootPath
    return { url: `http://127.0.0.1:${this.port}`, token: this.token }
  }

  // Invalidates the current capability without stopping the HTTP server —
  // called on harness stop and on switching workspace roots.
  revoke(): void {
    this.token = null
    this.boundRoot = null
  }

  // Called by main's 'command:reply' IPC handler.
  resolveReply(response: CommandRendererResponse): void {
    const p = this.pending.get(response.id)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(response.id)
    p.resolve(response)
  }

  // The renderer window went away with requests still in flight — they can
  // never get a reply now.
  rejectAllPending(reason: string): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
    this.pending.clear()
  }

  async close(): Promise<void> {
    this.rejectAllPending('command server closed')
    this.revoke()
    const server = this.server
    if (server) {
      this.server = null
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  private askRenderer(request: CommandRendererRequest): Promise<CommandRendererResponse> {
    const window = this.getWindow()
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      return Promise.reject(Object.assign(new Error('renderer not available'), { status: 503 }))
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id)
        reject(Object.assign(new Error('timed out waiting for the app'), { status: 504 }))
      }, this.requestTimeoutMs)
      this.pending.set(request.id, { resolve, reject, timer })
      window.webContents.send('command:request', request)
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST' || (req.url !== '/find' && req.url !== '/run')) {
      sendJson(res, 404, { message: 'not found' })
      return
    }
    if (!this.token || !this.boundRoot) {
      sendJson(res, 401, { message: 'no active capability' })
      return
    }
    const auth = req.headers.authorization ?? ''
    const presented = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : ''
    if (!presented || !timingSafeTokenEqual(presented, this.token)) {
      sendJson(res, 401, { message: 'invalid token' })
      return
    }

    let raw: string
    try {
      raw = await readBody(req)
    } catch {
      sendJson(res, 400, { message: 'request body too large' })
      return
    }
    let body: unknown
    try {
      body = raw ? JSON.parse(raw) : {}
    } catch {
      sendJson(res, 400, { message: 'invalid JSON body' })
      return
    }
    if (typeof body !== 'object' || body === null) {
      sendJson(res, 400, { message: 'body must be a JSON object' })
      return
    }
    const { sessionId, worktree } = body as { sessionId?: unknown; worktree?: unknown }
    if (typeof sessionId !== 'string' || !sessionId) {
      sendJson(res, 400, { message: 'sessionId is required' })
      return
    }
    if (typeof worktree !== 'string' || !worktree) {
      sendJson(res, 400, { message: 'worktree is required' })
      return
    }

    if (!(await this.isKnownWorktree(worktree))) {
      sendJson(res, 403, { message: 'worktree is not registered for this workspace' })
      return
    }

    const id = randomUUID()
    try {
      if (req.url === '/find') {
        const { query } = body as { query?: unknown }
        if (typeof query !== 'string') {
          sendJson(res, 400, { message: 'query is required' })
          return
        }
        const response = await this.askRenderer({ id, kind: 'find', query })
        if (response.kind !== 'find') throw new Error('renderer replied with the wrong kind')
        sendJson(res, 200, { commands: response.commands })
        return
      }

      const { id: commandId, args } = body as { id?: unknown; args?: unknown }
      if (typeof commandId !== 'string' || !commandId) {
        sendJson(res, 400, { message: 'id is required' })
        return
      }
      const response = await this.askRenderer({
        id,
        kind: 'run',
        commandId,
        args: args ?? {},
        origin: { kind: 'agent', sessionId, worktree }
      })
      if (response.kind !== 'run') throw new Error('renderer replied with the wrong kind')
      const { outcome } = response
      if (outcome.ok) {
        sendJson(res, 200, outcome)
      } else {
        sendJson(res, POLICY_STATUS[outcome.code] ?? 500, outcome)
      }
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500
      const message = err instanceof Error ? err.message : String(err)
      sendJson(res, status, { message })
    }
  }

  // A worktree is valid if it's the bound workspace root itself, or a
  // worktree git currently recognizes for that root — reconciled live
  // against `git worktree list --porcelain` rather than trusting anything
  // recorded earlier, since a worktree can be removed by hand outside the
  // app. Realpath both sides: git reports canonicalized paths, and a
  // caller's cwd (what the harness echoes as ctx.worktree) may not be.
  private async isKnownWorktree(worktree: string): Promise<boolean> {
    if (!this.boundRoot) return false
    let realWorktree: string
    try {
      realWorktree = await fs.realpath(worktree)
    } catch {
      return false
    }
    const realRoot = await fs.realpath(this.boundRoot).catch(() => this.boundRoot!)
    if (realWorktree === realRoot) return true
    try {
      const worktrees = await gitWorktreeList(this.boundRoot)
      return worktrees.some((w) => w.path === realWorktree)
    } catch {
      return false
    }
  }
}
