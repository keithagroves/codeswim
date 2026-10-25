// Reads/writes `.codeswim/whiteboard/board.json`: the whiteboard's pages and
// the design conversation, so they survive a restart
// (plans/talking-whiteboard.md, Phase 6).
//
// The canvas is not a source of truth — mermaid diagrams are — so this file
// is local state, not project content. The directory carries its own
// `.gitignore` (`*`), which keeps it out of the user's commits without
// touching their root .gitignore; deleting that file opts in to sharing.
//
// The payload is opaque here: the renderer validates it with
// BoardModel.fromJSON and starts fresh on anything malformed. Main only
// bounds its size and writes atomically.

import { promises as fs } from 'node:fs'
import path from 'node:path'

const DIR = path.join('.codeswim', 'whiteboard')
const FILE = 'board.json'
/** A long conversation with many pages is well under this. */
export const MAX_WHITEBOARD_BYTES = 2 * 1024 * 1024

export async function readWhiteboardFile(rootPath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(rootPath, DIR, FILE), 'utf-8')
    return raw.length <= MAX_WHITEBOARD_BYTES ? raw : null
  } catch {
    return null
  }
}

export async function writeWhiteboardFile(rootPath: string, json: string): Promise<void> {
  if (typeof json !== 'string') throw new Error('whiteboard: expected a JSON string')
  if (Buffer.byteLength(json, 'utf-8') > MAX_WHITEBOARD_BYTES)
    throw new Error('whiteboard: too large to save')
  JSON.parse(json) // refuse to persist something that can't be read back
  const dir = path.join(rootPath, DIR)
  await fs.mkdir(dir, { recursive: true })
  const ignore = path.join(dir, '.gitignore')
  try {
    await fs.access(ignore)
  } catch {
    await fs.writeFile(
      ignore,
      '# Codeswim whiteboard: local design conversations. Delete this file to commit them.\n*\n',
      'utf-8'
    )
  }
  const file = path.join(dir, FILE)
  const temp = `${file}.tmp`
  await fs.writeFile(temp, json, 'utf-8')
  await fs.rename(temp, file)
}
