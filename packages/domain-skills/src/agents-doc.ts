import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// AGENTS.md holds agent instructions. Two scopes, mirroring skills:
//   - workspace: <root>/AGENTS.md   (the public AGENTS.md convention, repo root)
//   - global:    ~/.agents/AGENTS.md (shared across every workspace)
// The Tools → Context tab surfaces both and edits them in place.
const AGENTS_FILENAME = 'AGENTS.md'

export type AgentsScope = 'workspace' | 'global'

export interface AgentsDocContent {
  content: string
  exists: boolean
  size: number
}

export function agentsDocPath(scope: AgentsScope, rootPath: string | null): string {
  if (scope === 'global') return path.join(os.homedir(), '.agents', AGENTS_FILENAME)
  return path.join(rootPath ?? '', AGENTS_FILENAME)
}

export async function readAgentsDoc(
  scope: AgentsScope,
  rootPath: string | null
): Promise<AgentsDocContent> {
  try {
    const content = await fs.readFile(agentsDocPath(scope, rootPath), 'utf-8')
    return { content, exists: true, size: Buffer.byteLength(content, 'utf-8') }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { content: '', exists: false, size: 0 }
    }
    throw err
  }
}

export async function writeAgentsDoc(
  scope: AgentsScope,
  content: string,
  rootPath: string | null
): Promise<void> {
  const file = agentsDocPath(scope, rootPath)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content, 'utf-8')
}
