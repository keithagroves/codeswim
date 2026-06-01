// Verifies whether opencode discovers a skill that lives behind a symlink
// in ~/.agents/skills. Spawns opencode against a temp workspace, calls the
// /skill endpoint (client.skills), and prints whether the symlinked entry
// shows up. The symlink was pre-created by hand:
//   ln -s /tmp/codeswim-skill-link-test/source/symlink-test-skill \
//         ~/.agents/skills/symlink-test-skill

import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createOpencodeClient } from '@opencode-ai/sdk/client'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OPENCODE_BIN = resolve(__dirname, '..', 'node_modules', '.bin', 'opencode')
const workspace = '/tmp/codeswim-skill-link-test'

const child = spawn(OPENCODE_BIN, ['serve', '--port', '0'], {
  cwd: workspace,
  stdio: ['ignore', 'pipe', 'pipe']
})

let url = null
const onLine = (label) => (buf) => {
  for (const line of String(buf).split('\n')) {
    if (!line) continue
    if (!url) {
      const m = line.match(/https?:\/\/127\.0\.0\.1:\d+/)
      if (m) url = m[0]
    }
    if (label === 'err') process.stderr.write(`[err] ${line}\n`)
  }
}
child.stdout.on('data', onLine('out'))
child.stderr.on('data', onLine('err'))

await new Promise((res, rej) => {
  const t = setInterval(() => {
    if (url) {
      clearInterval(t)
      res()
    }
  }, 50)
  setTimeout(() => {
    clearInterval(t)
    rej(new Error('timeout waiting for url'))
  }, 20_000)
})
console.log('server:', url)

// v1 SDK doesn't expose the /skill endpoint as a named method, so hit it raw.
try {
  const res = await fetch(
    `${url}/skill?directory=${encodeURIComponent(workspace)}`
  )
  if (!res.ok) {
    throw new Error(`GET /skill → ${res.status} ${res.statusText}`)
  }
  const list = await res.json()
  if (!Array.isArray(list)) {
    console.log('unexpected shape:', JSON.stringify(list).slice(0, 400))
  } else {
    console.log(`got ${list.length} skills`)
    const target = list.find((s) => s.name === 'symlink-test-skill')
    if (target) {
      console.log('FOUND symlink-test-skill →', JSON.stringify(target))
    } else {
      console.log('NOT FOUND — symlinked skill was not discovered')
      console.log(
        'sample names:',
        list
          .slice(0, 8)
          .map((s) => s.name)
          .join(', ')
      )
    }
  }
} catch (err) {
  console.error('skills() failed:', err)
}

child.kill('SIGTERM')
process.exit(0)
