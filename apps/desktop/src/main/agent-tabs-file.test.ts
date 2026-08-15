import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAgentTabsFile, writeAgentTabsFile } from './agent-tabs-file'
import type { PersistedAgentTabs } from '@codeswim/contract'

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'codeswim-agent-tabs-'))
}

describe('readAgentTabsFile', () => {
  it('returns null when the file does not exist', async () => {
    const root = tempRoot()
    try {
      expect(await readAgentTabsFile(root)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns null for invalid JSON rather than throwing', async () => {
    const root = tempRoot()
    try {
      mkdirSync(join(root, '.codeswim'), { recursive: true })
      writeFileSync(join(root, '.codeswim', 'agent-tabs.json'), 'not json')
      expect(await readAgentTabsFile(root)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reads back what was written', async () => {
    const root = tempRoot()
    try {
      const data: PersistedAgentTabs = {
        tabs: [{ id: 'tab-1', sessionId: 'ses_abc', title: 'Fix rate limiting', directory: null }],
        activeAgentTabId: 'tab-1'
      }
      await writeAgentTabsFile(root, data)
      expect(await readAgentTabsFile(root)).toEqual(data)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('writeAgentTabsFile', () => {
  it('creates the .codeswim directory if missing', async () => {
    const root = tempRoot()
    try {
      await writeAgentTabsFile(root, {
        tabs: [{ id: 'tab-1', sessionId: null, title: 'Agent 1' }],
        activeAgentTabId: 'tab-1'
      })
      expect(existsSync(join(root, '.codeswim', 'agent-tabs.json'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('writes pretty-printed JSON with a trailing newline', async () => {
    const root = tempRoot()
    try {
      await writeAgentTabsFile(root, {
        tabs: [{ id: 'tab-1', sessionId: null, title: 'Agent 1' }],
        activeAgentTabId: 'tab-1'
      })
      const raw = readFileSync(join(root, '.codeswim', 'agent-tabs.json'), 'utf-8')
      expect(raw.endsWith('\n')).toBe(true)
      expect(raw).toContain('\n  ') // indented
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves no temp file behind after a successful write', async () => {
    const root = tempRoot()
    try {
      await writeAgentTabsFile(root, {
        tabs: [{ id: 'tab-1', sessionId: null, title: 'Agent 1' }],
        activeAgentTabId: 'tab-1'
      })
      expect(existsSync(join(root, '.codeswim', 'agent-tabs.json.tmp'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('deletes the file when writing an empty tab list', async () => {
    const root = tempRoot()
    try {
      const file = join(root, '.codeswim', 'agent-tabs.json')
      await writeAgentTabsFile(root, {
        tabs: [{ id: 'tab-1', sessionId: null, title: 'Agent 1' }],
        activeAgentTabId: 'tab-1'
      })
      expect(existsSync(file)).toBe(true)
      await writeAgentTabsFile(root, { tabs: [], activeAgentTabId: null })
      expect(existsSync(file)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not throw when deleting an already-absent file', async () => {
    const root = tempRoot()
    try {
      await expect(
        writeAgentTabsFile(root, { tabs: [], activeAgentTabId: null })
      ).resolves.toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
