import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readSourceExplanation, resolveWorkspaceFile } from './source-explanations'

describe('source explanations', () => {
  const dirs: string[] = []

  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  const workspace = async (): Promise<string> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codeswim-explanation-'))
    dirs.push(dir)
    await fs.mkdir(path.join(dir, 'src'), { recursive: true })
    await fs.writeFile(path.join(dir, 'src', 'auth.ts'), 'export const auth = true\n', 'utf-8')
    return dir
  }

  it('prefers the canonical companion explanation', async () => {
    const root = await workspace()
    const file = path.join(root, '.codeswim', 'explanations', 'src')
    await fs.mkdir(file, { recursive: true })
    await fs.writeFile(path.join(file, 'auth.ts.md'), '# Auth logic\n', 'utf-8')

    await expect(readSourceExplanation(root, 'src/auth.ts')).resolves.toEqual({
      sourcePath: 'src/auth.ts',
      documentPath: '.codeswim/explanations/src/auth.ts.md',
      content: '# Auth logic\n',
      exists: true
    })
  })

  it('supports an adjacent source-path markdown companion', async () => {
    const root = await workspace()
    await fs.writeFile(path.join(root, 'src', 'auth.ts.md'), '# Adjacent\n', 'utf-8')

    const result = await readSourceExplanation(root, 'src/auth.ts')
    expect(result.documentPath).toBe('src/auth.ts.md')
    expect(result.exists).toBe(true)
  })

  it('returns a rendered markdown fallback without exposing source contents', async () => {
    const root = await workspace()
    const result = await readSourceExplanation(root, 'src/auth.ts')

    expect(result.exists).toBe(false)
    expect(result.documentPath).toBe('.codeswim/explanations/src/auth.ts.md')
    expect(result.content).toContain('The companion document belongs at')
    expect(result.content).not.toContain('export const auth')
  })

  it('rejects paths outside the workspace', async () => {
    const root = await workspace()
    await expect(readSourceExplanation(root, '../secret.ts')).rejects.toThrow(
      'path escapes the workspace'
    )
    expect(() => resolveWorkspaceFile(root, '../secret.ts')).toThrow('path escapes the workspace')
  })
})
