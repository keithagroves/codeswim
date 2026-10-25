import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_WHITEBOARD_BYTES, readWhiteboardFile, writeWhiteboardFile } from './whiteboard-file'

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
