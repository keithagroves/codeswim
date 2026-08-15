import { afterEach, describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  parseBranchLine,
  parseStatusLine,
  ensureGitignore,
  parseGitLog,
  gitWorktreeAdd,
  gitWorktreeRemove
} from './git'

const execFileAsync = promisify(execFile)

const F = '\u001f' // field separator, matches git.ts LOG_FIELD
const R = '\u001e' // record separator, matches git.ts LOG_RECORD

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

describe('gitWorktreeAdd / gitWorktreeRemove', () => {
  const dirs: string[] = []

  afterEach(async () => {
    for (const d of dirs.splice(0)) {
      await fs.rm(d, { recursive: true, force: true }).catch(() => {})
    }
  })

  const repo = async (): Promise<string> => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), 'codeswim-gwt-'))
    dirs.push(d)
    await execFileAsync('git', ['init', '-q'], { cwd: d })
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: d })
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: d })
    await fs.writeFile(path.join(d, 'README.md'), 'hi\n', 'utf-8')
    await execFileAsync('git', ['add', '-A'], { cwd: d })
    await execFileAsync('git', ['commit', '-q', '-m', 'initial'], { cwd: d })
    return d
  }

  it('checks out a new branch into a fresh directory', async () => {
    const root = await repo()
    const worktreePath = path.join(os.tmpdir(), `codeswim-gwt-out-${Date.now()}`)
    dirs.push(worktreePath)
    const result = await gitWorktreeAdd(root, worktreePath, 'Fix the thing!')
    expect(result.path).toBe(worktreePath)
    expect(result.branch).toMatch(/^codeswim\/fix-the-thing-[a-z0-9]+$/)
    expect(await fs.readFile(path.join(worktreePath, 'README.md'), 'utf-8')).toBe('hi\n')

    const { stdout } = await execFileAsync('git', ['branch', '--list', result.branch], { cwd: root })
    expect(stdout).toContain(result.branch)
  })

  it('removes the worktree but leaves the branch for review', async () => {
    const root = await repo()
    const worktreePath = path.join(os.tmpdir(), `codeswim-gwt-out-${Date.now()}`)
    const result = await gitWorktreeAdd(root, worktreePath, 'Task')
    await gitWorktreeRemove(root, worktreePath)

    await expect(fs.access(worktreePath)).rejects.toThrow()
    const { stdout } = await execFileAsync('git', ['branch', '--list', result.branch], { cwd: root })
    expect(stdout).toContain(result.branch)
  })
})

describe('parseGitLog', () => {
  const record = (
    hash: string,
    author: string,
    date: string,
    subject: string,
    body: string
  ): string => [hash, author, date, subject, body].join(F) + R

  it('parses a single record into fields', () => {
    const raw = record('abc1234def', 'Ada', '2026-06-01T10:00:00Z', 'Add thing', 'Body line.')
    expect(parseGitLog(raw)).toEqual([
      {
        hash: 'abc1234def',
        shortHash: 'abc1234',
        author: 'Ada',
        date: '2026-06-01T10:00:00Z',
        subject: 'Add thing',
        body: 'Body line.',
        synthesized: false
      }
    ])
  })

  it('separates records joined by a newline', () => {
    const raw =
      record('h1aaaaaa', 'A', 'd1', 's1', 'b1') + '\n' + record('h2bbbbbb', 'B', 'd2', 's2', 'b2')
    const out = parseGitLog(raw)
    expect(out.map((c) => c.subject)).toEqual(['s1', 's2'])
    expect(out[1].shortHash).toBe('h2bbbbb')
  })

  it('detects the synthesized trailer', () => {
    const body = 'Reconstructed intent.\n\nCodeswim-Synthesized: true\nCodeswim-Coverage: pass'
    const out = parseGitLog(record('hhhhhhhh', 'A', 'd', 'subj', body))
    expect(out[0].synthesized).toBe(true)
  })

  it('keeps multi-line bodies intact', () => {
    const body = 'Line one.\nLine two.\nLine three.'
    expect(parseGitLog(record('hhhhhhhh', 'A', 'd', 'subj', body))[0].body).toBe(body)
  })

  it('returns an empty array for empty input', () => {
    expect(parseGitLog('')).toEqual([])
  })
})
