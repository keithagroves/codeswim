import { afterEach, describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseBranchLine, parseStatusLine, ensureGitignore } from './git'

describe('parseBranchLine', () => {
  it('reads a tracking branch header', () => {
    expect(parseBranchLine('main...origin/main [ahead 1]')).toBe('main')
  })

  it('reads a bare branch name', () => {
    expect(parseBranchLine('feature/x')).toBe('feature/x')
  })

  it('reads the unborn-branch line of a fresh repo', () => {
    expect(parseBranchLine('No commits yet on main')).toBe('main')
    expect(parseBranchLine('No commits yet on feature/y')).toBe('feature/y')
  })

  it('returns null for detached HEAD', () => {
    expect(parseBranchLine('HEAD (no branch)')).toBeNull()
    expect(parseBranchLine('HEAD detached at abc1234')).toBeNull()
  })
})

describe('parseStatusLine', () => {
  it('splits index and worktree status codes', () => {
    expect(parseStatusLine(' M src/a.ts')).toEqual({
      index: ' ',
      worktree: 'M',
      path: 'src/a.ts'
    })
    expect(parseStatusLine('A  src/b.ts')).toEqual({
      index: 'A',
      worktree: ' ',
      path: 'src/b.ts'
    })
  })

  it('keeps the new path for renames', () => {
    expect(parseStatusLine('R  old.ts -> new.ts')?.path).toBe('new.ts')
  })

  it('marks untracked entries', () => {
    expect(parseStatusLine('?? foo.ts')).toEqual({ index: '?', worktree: '?', path: 'foo.ts' })
  })

  it('unwraps quoted paths with special characters', () => {
    expect(parseStatusLine('A  "a b.ts"')?.path).toBe('a b.ts')
  })

  it('returns null for a too-short line', () => {
    expect(parseStatusLine('x')).toBeNull()
  })
})

describe('ensureGitignore', () => {
  const dirs: string[] = []

  afterEach(async () => {
    for (const d of dirs.splice(0)) {
      await fs.rm(d, { recursive: true, force: true }).catch(() => {})
    }
  })

  const tmp = async (): Promise<string> => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), 'codeswim-gi-'))
    dirs.push(d)
    return d
  }

  it('writes a default .gitignore when none exists', async () => {
    const dir = await tmp()
    expect(await ensureGitignore(dir)).toBe(true)
    const content = await fs.readFile(path.join(dir, '.gitignore'), 'utf-8')
    expect(content).toContain('node_modules/')
    expect(content).toContain('.env')
  })

  it('never clobbers an existing .gitignore', async () => {
    const dir = await tmp()
    await fs.writeFile(path.join(dir, '.gitignore'), 'custom-rule\n', 'utf-8')
    expect(await ensureGitignore(dir)).toBe(false)
    const content = await fs.readFile(path.join(dir, '.gitignore'), 'utf-8')
    expect(content).toBe('custom-rule\n')
  })

  it('is idempotent on a second call', async () => {
    const dir = await tmp()
    expect(await ensureGitignore(dir)).toBe(true)
    expect(await ensureGitignore(dir)).toBe(false)
  })
})
