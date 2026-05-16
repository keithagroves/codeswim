// Manages the opencode `serve` subprocess that powers codeswim's agent.
//
// We spawn opencode with `OPENCODE_CONFIG_CONTENT` set to a JSON config that
// loads our plugin (out/harness/plugin.mjs) and instructions (system.txt).
// The config is passed via env var so we never write into the user's
// workspace or global opencode config.

import { spawn, type ChildProcess } from 'node:child_process'
import { app } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export interface SidecarHandle {
  url: URL
  stop(): Promise<void>
}

const SERVER_READY_TIMEOUT_MS = 30_000

function resolveOpencodeBinary(): string {
  // node_modules/.bin/opencode is a Node shim that finds the platform binary.
  return path.join(app.getAppPath(), 'node_modules', '.bin', 'opencode')
}

function resolveHarness(): { plugin: string; instructions: string[] } {
  const root = app.isPackaged
    ? path.join(process.resourcesPath, 'harness')
    : path.join(app.getAppPath(), 'out', 'harness')
  return {
    plugin: pathToFileURL(path.join(root, 'plugin.mjs')).href,
    instructions: [
      path.join(root, 'prompt', 'system.txt'),
      path.join(root, 'prompt', 'mdd-fixes.md')
    ]
  }
}

interface StartOptions {
  workspaceRoot: string
  onStdout?: (line: string) => void
  onStderr?: (line: string) => void
  onExit?: (code: number | null) => void
}

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

  // Server binds to 127.0.0.1 only and we don't set OPENCODE_SERVER_PASSWORD,
  // so the SDK can talk to it without auth headers. If we ever expose this
  // beyond loopback, generate a password and proxy it via a custom fetch.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config)
  }
  delete env.OPENCODE_SERVER_PASSWORD

  const child = spawn(binary, ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
    cwd: opts.workspaceRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const url = await waitForServerUrl(child, opts)

  return {
    url,
    stop: () => stopChild(child)
  }
}

function waitForServerUrl(child: ChildProcess, opts: StartOptions): Promise<URL> {
  return new Promise((resolve, reject) => {
    let settled = false
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
      if (kind === 'stdout') opts.onStdout?.(line)
      else opts.onStderr?.(line)
    }

    pipeLines(child.stdout, (l) => onLine(l, 'stdout'))
    pipeLines(child.stderr, (l) => onLine(l, 'stderr'))

    child.once('exit', (code) => {
      opts.onExit?.(code)
      settle(() => reject(new Error(`opencode serve exited with code ${code} before reporting a URL`)))
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
