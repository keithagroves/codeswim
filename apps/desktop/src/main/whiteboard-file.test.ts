import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isShotFile,
  MAX_WHITEBOARD_BYTES,
  readWhiteboardFile,
  readWhiteboardShot,
  writeWhiteboardFile,
  writeWhiteboardShot
} from './whiteboard-file'

const dirs: string[] = []
async function workspace(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'codeswim-wb-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('whiteboard file', () => {
  it('round-trips and keeps itself out of git', async () => {
    const root = await workspace()
    expect(await readWhiteboardFile(root)).toBeNull()
    await writeWhiteboardFile(root, '{"board":1}')
    expect(await readWhiteboardFile(root)).toBe('{"board":1}')
    const ignore = await readFile(path.join(root, '.codeswim/whiteboard/.gitignore'), 'utf-8')
    expect(ignore.trim().split('\n').at(-1)).toBe('*')
  })

  it("doesn't overwrite a .gitignore the user changed", async () => {
    const root = await workspace()
    await writeWhiteboardFile(root, '{}')
    await writeFile(path.join(root, '.codeswim/whiteboard/.gitignore'), '', 'utf-8')
    await writeWhiteboardFile(root, '{"again":true}')
    expect(await readFile(path.join(root, '.codeswim/whiteboard/.gitignore'), 'utf-8')).toBe('')
  })

  it('refuses invalid or oversized payloads', async () => {
    const root = await workspace()
    await expect(writeWhiteboardFile(root, '{nope')).rejects.toThrow()
    await expect(
      writeWhiteboardFile(root, `"${'x'.repeat(MAX_WHITEBOARD_BYTES)}"`)
    ).rejects.toThrow(/too large/)
    expect(await readWhiteboardFile(root)).toBeNull()
  })
})

describe('whiteboard screenshots', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])

  it('saves and reads a screenshot beside the board, under its .gitignore', async () => {
    const root = await workspace()
    const name = await writeWhiteboardShot(root, jpeg)
    expect(isShotFile(name)).toBe(true)
    expect(await readWhiteboardShot(root, name)).toEqual(jpeg)
    const ignore = await readFile(path.join(root, '.codeswim/whiteboard/.gitignore'), 'utf-8')
    expect(ignore.trim().split('\n').at(-1)).toBe('*')
  })

  it('only reads its own file names, never a path', async () => {
    const root = await workspace()
    await writeWhiteboardFile(root, '{}')
    for (const bad of ['../board.json', 'board.json', '/etc/passwd', 'shot-x-123456.png'])
      expect(await readWhiteboardShot(root, bad)).toBeNull()
  })

  it('a save deletes screenshots the board no longer mentions, once they are a minute old', async () => {
    const root = await workspace()
    const kept = await writeWhiteboardShot(root, jpeg)
    const dropped = await writeWhiteboardShot(root, jpeg)
    const fresh = await writeWhiteboardShot(root, jpeg)
    const old = new Date(Date.now() - 5 * 60_000)
    for (const f of [kept, dropped])
      await utimes(path.join(root, '.codeswim/whiteboard/shots', f), old, old)
    await writeWhiteboardFile(root, JSON.stringify({ els: [{ image: { file: kept } }] }))
    const left = await readdir(path.join(root, '.codeswim/whiteboard/shots'))
    expect(left.sort()).toEqual([kept, fresh].sort())
  })
})
