// Runs the same linkFolder logic the main process exposes, in plain Node,
// and then asks opencode whether the symlinks were picked up. Verifies the
// end-to-end story (link → discover) without launching Electron.

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const SOURCE = '/tmp/codeswim-link-smoke/external'
const TARGET = path.join(os.homedir(), '.agents', 'skills')
const PREFIX = 'codeswim-link-smoke-'

function safeName(name) {
  return /^[A-Za-z0-9._ -]+$/.test(name)
}

async function clearExisting() {
  const entries = await fs.readdir(TARGET, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (e.name.startsWith(PREFIX)) {
      await fs.unlink(path.join(TARGET, e.name)).catch(() => {})
    }
  }
}

async function linkFolder() {
  await fs.mkdir(TARGET, { recursive: true })
  const linked = []
  const skipped = []
  const entries = await fs.readdir(SOURCE, { withFileTypes: true })
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue
    const childAbs = path.resolve(SOURCE, e.name)
    try {
      const st = await fs.stat(childAbs)
      if (!st.isDirectory()) {
        skipped.push({ name: e.name, reason: 'not a directory' })
        continue
      }
      await fs.access(path.join(childAbs, 'SKILL.md'))
    } catch {
      skipped.push({ name: e.name, reason: 'no SKILL.md' })
      continue
    }
    if (!safeName(e.name)) {
      skipped.push({ name: e.name, reason: 'invalid name' })
      continue
    }
    // Prefix the link name so we can tell what we created and tidy up later.
    const linkAt = path.join(TARGET, `${PREFIX}${e.name}`)
    try {
      await fs.lstat(linkAt)
      skipped.push({ name: e.name, reason: 'already exists' })
      continue
    } catch {
      // not present — fall through
    }
    await fs.symlink(childAbs, linkAt, 'dir')
    linked.push(`${PREFIX}${e.name}`)
  }
  return { linked, skipped }
}

await clearExisting()
const result = await linkFolder()
console.log('linked:', result.linked)
console.log('skipped:', result.skipped)

// Now ask opencode to list skills and confirm our linked entries are there.
const OPENCODE_BIN = path.resolve(__dirname, '..', 'node_modules', '.bin', 'opencode')
const workspace = '/tmp/codeswim-link-smoke'
await fs.mkdir(workspace, { recursive: true })

const child = spawn(OPENCODE_BIN, ['serve', '--port', '0'], {
  cwd: workspace,
  stdio: ['ignore', 'pipe', 'pipe']
})
let url = null
child.stdout.on('data', (b) => {
  const m = String(b).match(/https?:\/\/127\.0\.0\.1:\d+/)
  if (m && !url) url = m[0]
})
child.stderr.on('data', (b) => {
  const m = String(b).match(/https?:\/\/127\.0\.0\.1:\d+/)
  if (m && !url) url = m[0]
})
await new Promise((res, rej) => {
  const t = setInterval(() => {
    if (url) {
      clearInterval(t)
      res()
    }
  }, 50)
  setTimeout(() => {
    clearInterval(t)
    rej(new Error('timeout'))
  }, 20_000)
})

const res = await fetch(`${url}/skill?directory=${encodeURIComponent(workspace)}`)
const list = await res.json()
const expected = ['alpha-skill', 'beta-skill', 'gamma-skill']
const ours = list.filter((s) => expected.includes(s.name))
console.log(`opencode reports ${list.length} skills total; ${ours.length}/${expected.length} expected found`)
for (const s of ours) {
  console.log(`  ${s.name}  location=${s.location}`)
}

await clearExisting()
console.log('cleaned up.')
child.kill('SIGTERM')
process.exit(0)
