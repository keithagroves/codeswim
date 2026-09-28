// Claude Code IDE bridge: Codeswim acting as "the IDE" for a `claude` CLI
// running in the Claude Code tab, the way VS Code's Claude extension does for
// its integrated terminal. The user runs and signs in to their own CLI; we
// only serve the local IDE side of it.
//
// Protocol (read off the shipped VS Code extension + CLI, not a published
// spec — re-verify when the CLI's IDE behaviour changes):
//   - A WebSocket server on 127.0.0.1:<random port> speaking MCP (JSON-RPC 2.0
//     over text frames). Connections must carry the header
//     `x-claude-code-ide-authorization: <authToken>`.
//   - A lockfile at <CLAUDE_CONFIG_DIR or ~/.claude>/ide/<port>.lock:
//     { pid, workspaceFolders, ideName, transport: 'ws', runningInWindows,
//       authToken }. The CLI lists these to find IDEs; it drops ones whose
//     pid is dead, so pid is this (main) process.
//   - CLAUDE_CODE_SSE_PORT=<port> in the CLI's env makes it auto-connect to
//     exactly this server (see claudeEnv()).
//   - Tools the CLI calls: openDiff (blocks until the user accepts/rejects;
//     answers FILE_SAVED + final contents, or DIFF_REJECTED + tab name —
//     the CLI writes the file itself), close_tab / closeAllDiffTabs,
//     getDiagnostics (around edits), openFile, getOpenEditors,
//     getWorkspaceFolders, getCurrentSelection / getLatestSelection,
//     checkDocumentDirty, saveDocument.
//   - Notifications we send: selection_changed { text, filePath, fileUrl,
//     selection }. The CLI sends ide_connected { pid } once attached.
//
// Codeswim is a read-only navigator: nothing is ever dirty, there are no
// language diagnostics, and accepting a diff hands the CLI back its own
// proposed contents to write.

import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promises as fs, rmSync } from 'node:fs'
import { WebSocketServer, type WebSocket } from 'ws'
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from 'diff'
import type { ClaudeIdeDiff, ClaudeIdeEditorState, ClaudeIdeOpenFile } from '@codeswim/contract'

export const IDE_NAME = 'Codeswim'
const AUTH_HEADER = 'x-claude-code-ide-authorization'

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

export interface ClaudeIdeHost {
  version: string
  // Renderer channels: 'claude-ide:open-file' | 'claude-ide:show-diff' |
  // 'claude-ide:close-diff'.
  send(channel: 'claude-ide:open-file', payload: ClaudeIdeOpenFile): void
  send(channel: 'claude-ide:show-diff', payload: ClaudeIdeDiff): void
  send(channel: 'claude-ide:close-diff', payload: string | null): void
}

interface PendingDiff {
  newContents: string
  settle(result: ToolResult): void
}

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] })
const json = (v: unknown): ToolResult => text(JSON.stringify(v, null, 2))

const str = { type: 'string' }
const TOOLS = [
  {
    name: 'openDiff',
    description: 'Open a git diff for the file',
    inputSchema: {
      type: 'object',
      properties: {
        old_file_path: str,
        new_file_path: str,
        new_file_contents: str,
        tab_name: str
      },
      required: ['old_file_path', 'new_file_path', 'new_file_contents', 'tab_name']
    }
  },
  {
    name: 'getDiagnostics',
    description: 'Get language diagnostics from the IDE',
    inputSchema: { type: 'object', properties: { uri: str } }
  },
  {
    name: 'close_tab',
    description: 'Close a tab',
    inputSchema: { type: 'object', properties: { tab_name: str }, required: ['tab_name'] }
  },
  {
    name: 'closeAllDiffTabs',
    description: 'Close all diff tabs in the editor',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'openFile',
    description: 'Open a file in the editor and optionally select a range of text',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: str,
        preview: { type: 'boolean' },
        startText: str,
        endText: str,
        selectToEndOfLine: { type: 'boolean' },
        makeFrontmost: { type: 'boolean' }
      },
      required: ['filePath']
    }
  },
  {
    name: 'getOpenEditors',
    description: 'Get information about currently open editors',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'getWorkspaceFolders',
    description: 'Get all workspace folders currently open in the IDE',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'getCurrentSelection',
    description: 'Get the current text selection in the active editor',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'getLatestSelection',
    description: 'Get the most recent text selection (even if not in the active editor)',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'checkDocumentDirty',
    description: 'Check if a document has unsaved changes (is dirty)',
    inputSchema: { type: 'object', properties: { filePath: str }, required: ['filePath'] }
  },
  {
    name: 'saveDocument',
    description: 'Save a document with unsaved changes',
    inputSchema: { type: 'object', properties: { filePath: str }, required: ['filePath'] }
  }
]

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

// 1-based line range of startText..endText in `contents`, mirroring the VS
// Code extension's openFile matching (first occurrence; endText searched
// after startText). null when startText isn't found.
export function matchRange(
  contents: string,
  startText: string | undefined,
  endText: string | undefined
): { start: number; end: number } | null {
  if (!startText) return null
  const from = contents.indexOf(startText)
  if (from === -1) return null
  let to = from + startText.length
  if (endText) {
    const rel = contents.slice(to).indexOf(endText)
    if (rel !== -1) to = to + rel + endText.length
  }
  const lineAt = (offset: number): number => contents.slice(0, offset).split('\n').length
  return { start: lineAt(from), end: lineAt(Math.max(from, to - 1)) }
}

export class ClaudeIdeBridge {
  private server: Server | null = null
  private wss: WebSocketServer | null = null
  private client: WebSocket | null = null
  private port = 0
  private readonly token = randomUUID()
  private root: string | null = null
  private lockPath: string | null = null
  private editor: ClaudeIdeEditorState = { filePath: null, selection: null, text: '' }
  // Last non-empty selection, for getLatestSelection.
  private latest: ClaudeIdeEditorState | null = null
  private readonly diffs = new Map<string, PendingDiff>()
  private starting: Promise<void> | null = null
  private lockOps: Promise<void> = Promise.resolve()

  constructor(
    private readonly host: ClaudeIdeHost,
    private readonly configDir: string = claudeConfigDir()
  ) {}

  // Starts the server once; later calls reuse it.
  start(): Promise<void> {
    this.starting ??= new Promise<void>((resolve, reject) => {
      const server = createServer((_req, res) => {
        res.writeHead(404)
        res.end()
      })
      const wss = new WebSocketServer({ server })
      wss.on('connection', (ws, req) => {
        if (req.headers[AUTH_HEADER] !== this.token) {
          ws.close(1008, 'Unauthorized')
          return
        }
        // One CLI at a time, like the VS Code extension: a new connection
        // replaces the old one.
        if (this.client && this.client !== ws) this.client.close()
        this.client = ws
        ws.on('message', (data) => void this.onMessage(ws, String(data)))
        ws.on('close', () => {
          if (this.client !== ws) return
          this.client = null
          this.rejectAllDiffs()
        })
      })
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        this.server = server
        this.wss = wss
        const addr = server.address()
        this.port = typeof addr === 'object' && addr ? addr.port : 0
        resolve()
      })
    })
    return this.starting
  }

  // Env for the Claude Code tab's pty. CLAUDE_CODE_SSE_PORT pins the CLI to
  // this server and turns on auto-connect. Skip the CLI's "install the
  // extension for your IDE" step: if Codeswim itself was launched from a VS
  // Code terminal, TERM_PROGRAM=vscode leaks through and the CLI would try to
  // install Anthropic's VS Code extension; the TERM_PROGRAM leak is dropped
  // for the same reason.
  claudeEnv(base: NodeJS.ProcessEnv): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v
    if (env.TERM_PROGRAM === 'vscode') {
      delete env.TERM_PROGRAM
      delete env.TERM_PROGRAM_VERSION
    }
    delete env.VSCODE_INJECTION
    if (this.port) env.CLAUDE_CODE_SSE_PORT = String(this.port)
    env.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL = '1'
    return env
  }

  getPort(): number {
    return this.port
  }

  // Keeps the lockfile's workspaceFolders in step with the open folder; with
  // no folder, the lockfile is removed (nothing to be an IDE for).
  // Serialized: a folder switch is stopWatching (remove) then startWatching
  // (write the same port's path), and an unordered remove could land last.
  setWorkspace(root: string | null): Promise<void> {
    this.root = root
    const run = this.lockOps.then(() => this.syncLockfile(root))
    this.lockOps = run.catch(() => {})
    return run
  }

  private async syncLockfile(root: string | null): Promise<void> {
    if (!root) return this.removeLockfile()
    await this.start()
    const dir = join(this.configDir, 'ide')
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    this.lockPath = join(dir, `${this.port}.lock`)
    const lock = {
      pid: process.pid,
      workspaceFolders: [root],
      ideName: IDE_NAME,
      transport: 'ws',
      runningInWindows: process.platform === 'win32',
      authToken: this.token
    }
    await fs.writeFile(this.lockPath, JSON.stringify(lock), { mode: 0o600 })
  }

  private async removeLockfile(): Promise<void> {
    if (!this.lockPath) return
    const p = this.lockPath
    this.lockPath = null
    await fs.rm(p, { force: true }).catch(() => {})
  }

  // Synchronous so it completes inside Electron's before-quit (which doesn't
  // await). A crash leaves the lockfile behind, but the CLI deletes lockfiles
  // whose pid is no longer running.
  stop(): void {
    this.rejectAllDiffs()
    if (this.lockPath) rmSync(this.lockPath, { force: true })
    this.lockPath = null
    this.client?.close()
    this.wss?.close()
    this.server?.close()
  }

  reportEditor(state: ClaudeIdeEditorState): void {
    this.editor = state
    if (state.filePath && state.selection && !state.selection.isEmpty) this.latest = state
    this.notifySelection()
  }

  resolveDiff(tabName: string, accepted: boolean): void {
    const pending = this.diffs.get(tabName)
    if (!pending) return
    this.diffs.delete(tabName)
    // Accepting returns the proposed contents for the CLI to write; there's
    // no in-app editing, so they're exactly what it sent.
    const [status, detail] = accepted
      ? ['FILE_SAVED', pending.newContents]
      : ['DIFF_REJECTED', tabName]
    pending.settle({
      content: [
        { type: 'text', text: status },
        { type: 'text', text: detail }
      ]
    })
  }

  private rejectAllDiffs(): void {
    for (const tab of [...this.diffs.keys()]) this.resolveDiff(tab, false)
    this.host.send('claude-ide:close-diff', null)
  }

  private notifySelection(): void {
    const { filePath, selection, text: selected } = this.editor
    if (!this.client || !filePath || !selection) return
    this.sendNotification('selection_changed', {
      text: selected,
      filePath,
      fileUrl: pathToFileURL(filePath).href,
      selection
    })
  }

  private sendNotification(method: string, params: unknown): void {
    this.client?.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
  }

  private async onMessage(ws: WebSocket, raw: string): Promise<void> {
    let msg: { id?: number | string; method?: string; params?: Record<string, unknown> }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (!msg.method) return // a response to something we sent; we send none
    if (msg.id === undefined) {
      // Notifications. Once the CLI is attached, hand it the current selection
      // (the VS Code extension does the same shortly after connect).
      if (msg.method === 'ide_connected' || msg.method === 'notifications/initialized') {
        this.notifySelection()
      }
      return
    }
    const reply = (
      body: { result: unknown } | { error: { code: number; message: string } }
    ): void => {
      if (ws.readyState === ws.OPEN)
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...body }))
    }
    switch (msg.method) {
      case 'initialize':
        return reply({
          result: {
            protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'codeswim', version: this.host.version }
          }
        })
      case 'ping':
        return reply({ result: {} })
      case 'tools/list':
        return reply({ result: { tools: TOOLS } })
      case 'tools/call': {
        const name = String(msg.params?.name ?? '')
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
        try {
          return reply({ result: await this.callTool(name, args) })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return reply({ result: { ...text(message), isError: true } })
        }
      }
      default:
        return reply({ error: { code: -32601, message: `Method not found: ${msg.method}` } })
    }
  }

  // Root-relative posix path for a CLI-supplied path, or null when it falls
  // outside the open folder (the navigator only shows workspace files).
  private toRel(p: string): string | null {
    if (!this.root) return null
    const abs = isAbsolute(p) ? p : join(this.root, p)
    const rel = relative(this.root, abs)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
    return rel.split(sep).join('/')
  }

  private absolute(p: string): string {
    return isAbsolute(p) || !this.root ? p : join(this.root, p)
  }

  private selectionPayload(state: ClaudeIdeEditorState | null, emptyMessage: string): ToolResult {
    if (!state?.filePath || !state.selection) return json({ success: false, message: emptyMessage })
    return json({
      success: true,
      text: state.text,
      filePath: state.filePath,
      fileUrl: pathToFileURL(state.filePath).href,
      selection: state.selection
    })
  }

  private async callTool(name: string, a: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case 'openDiff':
        return this.openDiff(a)
      case 'getDiagnostics':
        // No language services in a read-only navigator.
        return text('[]')
      case 'close_tab': {
        const tab = String(a.tab_name ?? '')
        this.resolveDiff(tab, false)
        this.host.send('claude-ide:close-diff', tab)
        return text('TAB_CLOSED')
      }
      case 'closeAllDiffTabs': {
        const n = this.diffs.size
        this.rejectAllDiffs()
        return text(`CLOSED_${n}_DIFF_TABS`)
      }
      case 'openFile': {
        const abs = this.absolute(String(a.filePath ?? ''))
        const rel = this.toRel(abs)
        if (!rel) return json({ success: false, message: `Not in the open folder: ${abs}` })
        let range: ClaudeIdeOpenFile['range'] = null
        if (typeof a.startText === 'string') {
          const contents = await fs.readFile(abs, 'utf8').catch(() => '')
          range = matchRange(
            contents,
            a.startText,
            typeof a.endText === 'string' ? a.endText : undefined
          )
        }
        this.host.send('claude-ide:open-file', { relPath: rel, range })
        return json({ success: true, filePath: abs, message: `Opened file: ${abs}` })
      }
      case 'getOpenEditors': {
        const { filePath, selection } = this.editor
        const tabs = filePath
          ? [
              {
                uri: pathToFileURL(filePath).href,
                isActive: true,
                isPinned: false,
                isPreview: false,
                isDirty: false,
                label: filePath.split(sep).pop(),
                groupIndex: 0,
                viewColumn: 1,
                isGroupActive: true,
                fileName: filePath,
                ...(selection ? { selection: { ...selection, isReversed: false } } : {})
              }
            ]
          : []
        return json({ tabs })
      }
      case 'getWorkspaceFolders': {
        const folders = this.root
          ? [
              {
                name: this.root.split(sep).pop(),
                uri: pathToFileURL(this.root).href,
                path: this.root,
                index: 0
              }
            ]
          : []
        return json({ success: true, folders, rootPath: this.root, workspaceFile: null })
      }
      case 'getCurrentSelection':
        return this.selectionPayload(this.editor, 'No active editor found')
      case 'getLatestSelection':
        return this.selectionPayload(this.latest, 'No selection available')
      case 'checkDocumentDirty':
        return json({
          success: true,
          filePath: this.absolute(String(a.filePath ?? '')),
          isDirty: false,
          isUntitled: false
        })
      case 'saveDocument':
        return json({
          success: true,
          filePath: this.absolute(String(a.filePath ?? '')),
          saved: false,
          message: 'Document has no unsaved changes'
        })
      default:
        throw new Error(`Unknown tool: ${name}`)
    }
  }

  // Shows the proposed edit and blocks until the user accepts or rejects it
  // in Codeswim, the CLI closes the tab (it was answered in the terminal),
  // or the CLI disconnects.
  private async openDiff(a: Record<string, unknown>): Promise<ToolResult> {
    const oldPath = this.absolute(String(a.old_file_path ?? ''))
    const newPath = this.absolute(String(a.new_file_path ?? oldPath))
    const newContents = String(a.new_file_contents ?? '')
    const tabName = String(a.tab_name ?? newPath)
    const oldContents = await fs.readFile(oldPath, 'utf8').catch(() => '')
    const label = this.toRel(newPath) ?? newPath
    const diff = createTwoFilesPatch(label, label, oldContents, newContents, '', '', {
      context: 3,
      // --- / +++ only, matching git's output in the same view (no Index: / ===).
      headerOptions: FILE_HEADERS_ONLY
    })
    // A repeat for the same tab supersedes the earlier one.
    this.resolveDiff(tabName, false)
    return new Promise<ToolResult>((settle) => {
      this.diffs.set(tabName, { newContents, settle })
      this.host.send('claude-ide:show-diff', { tabName, relPath: label, diff })
    })
  }
}
