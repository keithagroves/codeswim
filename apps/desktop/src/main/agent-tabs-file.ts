// Reads/writes `.codeswim/agent-tabs.json` — the persisted Agents-view tab
// strip (see PersistedAgentTabs in @codeswim/contract). Mirrors
// @codeswim/domain-kanban's board.json handling: atomic temp-file + rename
// so a crash mid-write can't corrupt the file.
//
// Deliberately NOT written via @codeswim/domain-kanban or a shared package —
// this is desktop-app-specific (Agents-view tabs aren't a portable domain
// concept) and small enough to keep local. Gitignored (see .gitignore):
// session ids are personal, local-only state, not project content.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { normalizePersistedAgentTabs, type PersistedAgentTabs } from '@codeswim/contract'

const RELATIVE_PATH = path.join('.codeswim', 'agent-tabs.json')

function filePath(rootPath: string): string {
  return path.join(rootPath, RELATIVE_PATH)
}

export async function readAgentTabsFile(rootPath: string): Promise<PersistedAgentTabs | null> {
  try {
    const raw = await fs.readFile(filePath(rootPath), 'utf-8')
    return normalizePersistedAgentTabs(JSON.parse(raw))
  } catch {
    // Missing file, unreadable, or invalid JSON — nothing to restore.
    return null
  }
}

export async function writeAgentTabsFile(
  rootPath: string,
  data: PersistedAgentTabs
): Promise<void> {
  const file = filePath(rootPath)
  if (data.tabs.length === 0) {
    await fs.rm(file, { force: true })
    return
  }
  const temp = `${file}.tmp`
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf-8')
  await fs.rename(temp, file)
}
