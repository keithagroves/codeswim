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
//
// Screenshots the narrator puts on the board are JPEGs in `shots/` beside
// it (under the same .gitignore); the board names them by file. Each save
// deletes the ones it no longer mentions.

import { randomBytes } from 'node:crypto'
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
  const dir = await whiteboardDir(rootPath)
  const file = path.join(dir, FILE)
  const temp = `${file}.tmp`
  await fs.writeFile(temp, json, 'utf-8')
  await fs.rename(temp, file)
  await pruneWhiteboardShots(rootPath, json).catch(() => {})
}

/** The whiteboard's folder, created with its .gitignore the first time. */
async function whiteboardDir(rootPath: string): Promise<string> {
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
  return dir
}

const SHOTS = 'shots'
const SHOT_FILE = /^shot-[a-z0-9]+-[a-f0-9]{6}\.jpg$/
/** A screenshot as main saves it (JPEG, at most 1280 wide) is far under this. */
export const MAX_SHOT_BYTES = 2 * 1024 * 1024
/** A shot this new may not be on the saved board yet (it's being placed). */
const PRUNE_GRACE_MS = 60_000

export function isShotFile(name: unknown): name is string {
  return typeof name === 'string' && SHOT_FILE.test(name)
}

/** Save a screenshot for the board; resolves with its file name in shots/. */
export async function writeWhiteboardShot(
  rootPath: string,
  jpeg: Buffer,
  now = Date.now()
): Promise<string> {
  if (jpeg.length > MAX_SHOT_BYTES) throw new Error('whiteboard: screenshot too large')
  const dir = path.join(await whiteboardDir(rootPath), SHOTS)
  await fs.mkdir(dir, { recursive: true })
  const name = `shot-${now.toString(36)}-${randomBytes(3).toString('hex')}.jpg`
  await fs.writeFile(path.join(dir, name), jpeg)
  return name
}

export async function readWhiteboardShot(rootPath: string, name: string): Promise<Buffer | null> {
  if (!isShotFile(name)) return null
  try {
    const data = await fs.readFile(path.join(rootPath, DIR, SHOTS, name))
    return data.length <= MAX_SHOT_BYTES ? data : null
  } catch {
    return null
  }
}

/** Delete screenshots the saved board no longer mentions (once they're a minute old). */
export async function pruneWhiteboardShots(
  rootPath: string,
  json: string,
  now = Date.now()
): Promise<void> {
  const dir = path.join(rootPath, DIR, SHOTS)
  const files = await fs.readdir(dir).catch(() => [] as string[])
  await Promise.all(
    files
      .filter((f) => isShotFile(f) && !json.includes(`"${f}"`))
      .map(async (f) => {
        const file = path.join(dir, f)
        const stat = await fs.stat(file).catch(() => null)
        if (stat && now - stat.mtimeMs >= PRUNE_GRACE_MS) await fs.rm(file, { force: true })
      })
  )
}
