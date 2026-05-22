#!/usr/bin/env node
// Diagnostic: spawn opencode against a workspace, subscribe to its SSE
// /event stream, send a prompt, and log every event that flows back.
// Answers "what does opencode actually emit?" without involving Electron or
// the renderer.
//
// Usage:
//   node scripts/test-events.mjs <workspace> ["your prompt"]
//
// Workspace defaults to cwd; prompt defaults to a short ping.
// Relies on the user having already configured an API key in opencode (run
// the app once and set up a provider, or `opencode auth login` in a terminal).

import { spawn } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createOpencodeClient } from '@opencode-ai/sdk/client'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OPENCODE_BIN = resolve(__dirname, '..', 'node_modules', '.bin', 'opencode')

const workspace = resolve(process.argv[2] ?? process.cwd())
const prompt = process.argv[3] ?? 'In one short sentence, what is mermaid?'

console.log('workspace:', workspace)
console.log('prompt:', prompt)
console.log('---')

const child = spawn(OPENCODE_BIN, ['serve', '--port', '0'], {
  cwd: workspace,
  stdio: ['ignore', 'pipe', 'pipe']
})

let serverUrl = null
const onLine = (line) => {
  process.stderr.write(`[opencode] ${line}\n`)
  if (!serverUrl) {
    const m = line.match(/https?:\/\/127\.0\.0\.1:\d+/)
    if (m) serverUrl = m[0]
  }
}
const splitter = () => {
  let buf = ''
  return (chunk) => {
    buf += chunk.toString()
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      onLine(buf.slice(0, i))
      buf = buf.slice(i + 1)
    }
  }
}
child.stdout.on('data', splitter())
child.stderr.on('data', splitter())

const waitForUrl = new Promise((res, rej) => {
  const t = setInterval(() => {
    if (serverUrl) {
      clearInterval(t)
      res()
    }
  }, 50)
  child.on('exit', (code, signal) =>
    rej(new Error(`opencode exited before reporting a URL (code ${code}, signal ${signal})`))
  )
  setTimeout(() => {
    clearInterval(t)
    rej(new Error('timed out waiting for opencode URL (30s)'))
  }, 30_000)
})

await waitForUrl
console.log('server:', serverUrl)

const client = createOpencodeClient({ baseUrl: serverUrl, directory: workspace })
const abort = new AbortController()

const streamDone = (async () => {
  try {
    const { stream } = await client.global.event({
      signal: abort.signal
    })
    console.log('subscribed to', `${serverUrl}/global/event`)
    let i = 0
    const byType = new Map()
    for await (const envelope of stream) {
      i++
      // /global/event wraps each event in { directory, payload }.
      const evt = envelope?.payload ?? envelope
      byType.set(evt?.type, (byType.get(evt?.type) ?? 0) + 1)
      if (evt?.type === 'message.part.updated') {
        const p = evt.properties?.part
        const summary = p
          ? `${p.type} id=${p.id?.slice(-6)} ${p.text ? `text(${p.text.length}ch)` : ''} ${p.tool ?? ''} ${p.state?.status ?? ''}`.trim()
          : '(no part)'
        console.log(`#${i} ${evt.type} → ${summary}`)
      } else if (i <= 15 || i % 25 === 0) {
        console.log(`#${i} ${evt?.type}`)
      }
    }
    console.log('---')
    console.log('event counts:')
    for (const [t, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${n.toString().padStart(4)}  ${t}`)
    }
  } catch (err) {
    if (!abort.signal.aborted) console.error('stream error:', err)
  }
})()

const providers = await client.config.providers({ throwOnError: true })
const ids = providers.data?.providers?.map((p) => p.id) ?? []
if (ids.length === 0) {
  console.error('no providers configured — run the app once and set an API key, then retry.')
  abort.abort()
  child.kill('SIGTERM')
  process.exit(2)
}
console.log('providers:', ids.join(', '))

const session = await client.session.create({
  query: { directory: workspace },
  throwOnError: true
})
console.log('session:', session.data.id)

console.log('sending prompt (async)…')
const result = await client.session.promptAsync({
  path: { id: session.data.id },
  query: { directory: workspace },
  body: { parts: [{ type: 'text', text: prompt }] },
  throwOnError: true
})
console.log('promptAsync returned', JSON.stringify(result.data ?? null).slice(0, 200))

// promptAsync returns immediately; the model is still working. Wait long
// enough for the response + tools to finish before tearing down.
setTimeout(() => {
  abort.abort()
  child.kill('SIGTERM')
}, 30_000)

await streamDone
process.exit(0)
