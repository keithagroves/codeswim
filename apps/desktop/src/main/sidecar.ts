// Manages the opencode `serve` subprocess that powers codeswim's agent.
//
// We spawn opencode with `OPENCODE_CONFIG_CONTENT` set to a JSON config that
// loads our plugin (out/harness/plugin.mjs) and instructions (system.txt).
// The config is passed via env var so we never write into the user's
// workspace or global opencode config.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { app } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildSidecarEnv, type SidecarChatConfig, type SidecarCommandConfig } from './sidecar-env'

export interface SidecarHandle {
  url: URL
  stop(): Promise<void>
}

const SERVER_READY_TIMEOUT_MS = 30_000

// In packaged builds, asarUnpack'd files live at app.asar.unpacked/ next
// to app.asar. We unpack opencode-ai (the Node shim), the platform-specific
// opencode-{platform}-{arch} package (which holds the actual binary), and
// out/harness so our plugin file:// URL points at a real file.
function resolveUnpacked(...segments: string[]): string {
  const base = app.isPackaged
    ? app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked')
    : app.getAppPath()
  return path.join(base, ...segments)
}

function resolveOpencodeBinary(): string {
  // Spawn the real platform binary directly rather than node_modules/.bin/
  // opencode. That .bin entry is a shell shim — on Windows it's a .cmd/.ps1
  // (or an extensionless sh script) that Node's spawn can't exec without a
  // shell, so the sidecar would never start there. The platform package lays
  // the binary out as opencode-{platform}-{arch}/bin/opencode[.exe] (see
  // opencode-ai's postinstall.mjs); those packages are asarUnpack'd, so the
  // path is real on disk in packaged builds too.
  const platform =
    process.platform === 'win32'
      ? 'windows'
      : process.platform === 'darwin'
        ? 'darwin'
        : 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const binaryName = platform === 'windows' ? 'opencode.exe' : 'opencode'
  const rel = path.join('node_modules', `opencode-${platform}-${arch}`, 'bin', binaryName)

  // Packaged: the platform package is asarUnpack'd next to app.asar.
  if (app.isPackaged) return resolveUnpacked(rel)

  // Dev: under npm workspaces the platform package is hoisted to the monorepo
  // root node_modules, not the app's, so walk up from the app dir to find it.
  let dir = app.getAppPath()
  for (;;) {
    const candidate = path.join(dir, rel)
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // Nothing found — return the app-relative path so the spawn error is clear.
  return resolveUnpacked(rel)
}

function resolveHarness(): { plugin: string; instructions: string[] } {
  const root = resolveUnpacked('out', 'harness')
  return {
    plugin: pathToFileURL(path.join(root, 'plugin.mjs')).href,
    instructions: [
      path.join(root, 'prompt', 'system.txt'),
      path.join(root, 'prompt', 'mdd-fixes.md')
    ]
  }
}

interface ExitInfo {
  signal: NodeJS.Signals | null
  stderrTail: string[]
}

interface StartOptions {
  workspaceRoot: string
  // Chat room identity/credential for this workspace, or null when there's
  // no shared git remote to key a room on. See buildSidecarEnv.
  chat?: SidecarChatConfig | null
  // Command-bridge capability for this run. See buildSidecarEnv.
  command?: SidecarCommandConfig | null
  onStdout?: (line: string) => void
  onStderr?: (line: string) => void
  onExit?: (code: number | null, info: ExitInfo) => void
}

const STDERR_TAIL_LIMIT = 40

export async function startSidecar(opts: StartOptions): Promise<SidecarHandle> {
  const binary = resolveOpencodeBinary()
  const harness = resolveHarness()

  const config = {
    plugin: [harness.plugin],
    instructions: harness.instructions,
    // Auto-approve all tool prompts. The diagrams-first gate in our plugin
    // still blocks `write`/`edit` until a `diagram_edit` happens, so this
    // doesn't undermine the opinionation. A future permission-prompt UI in
    // the renderer can replace this with `"ask"` for sensitive tools.
    permission: 'allow'
  }

  // Isolation + config injection rationale lives in sidecar-env.ts.
  const { env, xdgDirs } = buildSidecarEnv(
    process.env,
    path.join(app.getPath('userData'), 'opencode-xdg'),
    config,
    opts.chat,
    opts.command
  )
  for (const dir of xdgDirs) mkdirSync(dir, { recursive: true })

  const stderrTail: string[] = []
  const recordStderr = (line: string): void => {
    stderrTail.push(line)
    if (stderrTail.length > STDERR_TAIL_LIMIT) stderrTail.shift()
    opts.onStderr?.(line)
  }

  const child = spawn(binary, ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
    cwd: opts.workspaceRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // No-op off Windows; on Windows it stops a console window flashing up.
    windowsHide: true
  })

  // One exit listener; carries stderr tail so the renderer can show *why*.
  child.once('exit', (code, signal) => {
    opts.onExit?.(code, { signal, stderrTail: [...stderrTail] })
  })

  const url = await waitForServerUrl(child, opts.onStdout, recordStderr)

  return {
    url,
    stop: () => stopChild(child)
  }
}

function waitForServerUrl(
  child: ChildProcess,
  onStdout: ((line: string) => void) | undefined,
  onStderr: (line: string) => void
): Promise<URL> {
  return new Promise((resolve, reject) => {
    let settled = false
    const stderrSeen: string[] = []
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    const timer = setTimeout(() => {
      settle(() =>
        reject(new Error(`opencode serve did not report a URL within ${SERVER_READY_TIMEOUT_MS}ms`))
      )
      child.kill('SIGTERM')
    }, SERVER_READY_TIMEOUT_MS)

    const onLine = (line: string, kind: 'stdout' | 'stderr') => {
      const match = line.match(/listening on (https?:\/\/\S+)/i)
      if (match) settle(() => resolve(new URL(match[1])))
      if (kind === 'stdout') onStdout?.(line)
      else {
        stderrSeen.push(line)
        onStderr(line)
      }
    }

    pipeLines(child.stdout, (l) => onLine(l, 'stdout'))
    pipeLines(child.stderr, (l) => onLine(l, 'stderr'))

    // Track early exit during startup; the post-startup exit listener in
    // startSidecar handles later exits.
    child.once('exit', (code, signal) => {
      const detail = stderrSeen.length > 0 ? `\n  stderr:\n    ${stderrSeen.slice(-5).join('\n    ')}` : ''
      settle(() =>
        reject(
          new Error(
            `opencode serve exited (code ${code ?? 'null'}, signal ${signal ?? 'null'}) before reporting a URL.${detail}`
          )
        )
      )
    })
    child.once('error', (err) => settle(() => reject(err)))
  })
}

function pipeLines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  if (!stream) return
  let buffer = ''
  stream.setEncoding('utf-8')
  stream.on('data', (chunk: string) => {
    buffer += chunk
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '')
      buffer = buffer.slice(idx + 1)
      if (line) onLine(line)
    }
  })
  stream.on('end', () => {
    if (buffer.trim()) onLine(buffer.trim())
  })
}

function stopChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    const onExit = (): void => resolve()
    child.once('exit', onExit)
    child.kill('SIGTERM')
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 5_000)
  })
}
