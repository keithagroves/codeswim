// Git operations for the prompt-commits feature. Everything here shells out
// to the `git` binary with an ARGS ARRAY and no `shell: true` — unlike the
// npm script runner (which needs a shell for PATH resolution of npm/tsx),
// git takes structured input only, so we keep zero shell-injection surface.
// cwd is always pinned to the workspace root.
//
// NOTE on packaged builds: we invoke `git` off PATH. On macOS GUI launches
// the default launchd PATH includes /usr/bin where Apple ships git, and on
// Windows the installer puts git on PATH, so this resolves in practice. If a
// user has no git on PATH, gitStatus throws and the panel surfaces it.

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// A conservative, ecosystem-light default. We only write this when there's
// no .gitignore at all — enough to keep `git add -A` from sweeping in
// dependencies, build output, secrets, and OS cruft on the first commit.
const DEFAULT_GITIGNORE = `# Dependencies
node_modules/

# Build output
dist/
build/
out/
*.tsbuildinfo

# Logs
*.log
npm-debug.log*
yarn-error.log*

# Environment / secrets
.env
.env.local
.env.*.local

# OS / editor cruft
.DS_Store
Thumbs.db
.idea/

# Test coverage
coverage/
`

// Diffs and logs can be large; default 1MB maxBuffer is too small.
const MAX_BUFFER = 64 * 1024 * 1024

export interface GitFileChange {
  // Path relative to the repo root (the new path for renames).
  path: string
  // Porcelain index (staged) and worktree status codes, e.g. 'M', 'A', 'D'.
  index: string
  worktree: string
}

export interface GitStatus {
  // false when the workspace folder is not inside a git work tree — the
  // panel offers to initialize one. All the other fields are empty/default
  // in that case.
  isRepo: boolean
  // null when on a detached HEAD or an unborn branch with no name yet.
  branch: string | null
  staged: GitFileChange[]
  unstaged: GitFileChange[]
  untracked: string[]
  clean: boolean
}

const NOT_A_REPO: GitStatus = {
  isRepo: false,
  branch: null,
  staged: [],
  unstaged: [],
  untracked: [],
  clean: true
}

async function git(rootPath: string, args: string[]): Promise<string> {
  if (!rootPath) throw new Error('no workspace open')
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: rootPath,
      maxBuffer: MAX_BUFFER,
      // Force machine-stable output regardless of the user's git config.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
    })
    return stdout
  } catch (err) {
    const e = err as { code?: string; stderr?: string; message?: string }
    if (e.code === 'ENOENT') {
      throw new Error('git not found on PATH')
    }
    const detail = (e.stderr || e.message || '').trim()
    throw new Error(detail || 'git command failed')
  }
}

// Parse the porcelain `## ...` branch header (the part after '## ') into a
// branch name, or null for detached HEAD. Exported for unit testing.
export function parseBranchLine(rest: string): string | null {
  // 'No commits yet on main' — fresh repo, unborn branch.
  const unborn = rest.match(/^No commits yet on (.+)$/)
  if (unborn) return unborn[1].trim() || null
  // 'main...origin/main [ahead 1]' or just 'main'.
  const head = rest.split('...')[0].split(' ')[0]
  if (head === 'HEAD' || head.includes('(')) return null
  return head || null
}

export function parseStatusLine(line: string): GitFileChange | null {
  // Porcelain v1: two status chars, a space, then the path. Renames/copies
  // render as 'old -> new'; we keep the new path.
  if (line.length < 4) return null
  const index = line[0]
  const worktree = line[1]
  let path = line.slice(3)
  const arrow = path.indexOf(' -> ')
  if (arrow !== -1) path = path.slice(arrow + 4)
  // Porcelain quotes paths with special chars in double quotes; unwrap.
  if (path.startsWith('"') && path.endsWith('"')) {
    path = path.slice(1, -1)
  }
  return { path, index, worktree }
}

export async function gitStatus(rootPath: string): Promise<GitStatus> {
  let out: string
  try {
    out = await git(rootPath, ['status', '--porcelain=v1', '--branch'])
  } catch (err) {
    // The folder simply isn't a repo yet — a normal, offer-to-init state,
    // not an error to surface. Anything else (e.g. git missing) re-throws.
    const msg = err instanceof Error ? err.message : String(err)
    if (/not a git repository/i.test(msg)) return NOT_A_REPO
    throw err
  }
  const lines = out.split('\n').filter((l) => l.length > 0)

  let branch: string | null = null
  const staged: GitFileChange[] = []
  const unstaged: GitFileChange[] = []
  const untracked: string[] = []

  for (const line of lines) {
    if (line.startsWith('## ')) {
      branch = parseBranchLine(line.slice(3))
      continue
    }
    const change = parseStatusLine(line)
    if (!change) continue
    if (change.index === '?' && change.worktree === '?') {
      untracked.push(change.path)
      continue
    }
    if (change.index !== ' ' && change.index !== '?') staged.push(change)
    if (change.worktree !== ' ' && change.worktree !== '?') unstaged.push(change)
  }

  const clean = staged.length === 0 && unstaged.length === 0 && untracked.length === 0
  return { isRepo: true, branch, staged, unstaged, untracked, clean }
}

export interface GitInitResult {
  // Whether we wrote a fresh .gitignore (false if one already existed).
  createdGitignore: boolean
}

// Writes the default .gitignore only when the workspace has none — never
// clobbers an existing one. Returns whether it created the file.
export async function ensureGitignore(rootPath: string): Promise<boolean> {
  const file = path.join(rootPath, '.gitignore')
  try {
    await fs.access(file)
    return false // already present — leave the user's rules alone
  } catch {
    // not present — fall through and create it
  }
  await fs.writeFile(file, DEFAULT_GITIGNORE, 'utf-8')
  return true
}

// Initialize a git repository in the workspace root and seed a .gitignore so
// the first `git add -A` doesn't sweep in node_modules/build/secrets. Safe to
// call on an already-initialized repo (git reinitializes), but the panel only
// offers it when gitStatus reports isRepo === false.
export async function gitInit(rootPath: string): Promise<GitInitResult> {
  await git(rootPath, ['init'])
  const createdGitignore = await ensureGitignore(rootPath)
  return { createdGitignore }
}

// Stage every change in the work tree (`git add -A`) — additions, edits, and
// deletions. Used to assemble a commit (notably the first one) from the panel.
export async function gitStageAll(rootPath: string): Promise<void> {
  await git(rootPath, ['add', '-A'])
}

export async function gitStagedDiff(rootPath: string): Promise<string> {
  // --staged shows what `git commit` would record. No color, full context.
  return git(rootPath, ['diff', '--staged', '--no-color'])
}

export async function gitCommit(rootPath: string, subject: string, body: string): Promise<string> {
  const trimmedSubject = subject.trim()
  if (!trimmedSubject) throw new Error('commit subject is empty')
  // Two -m flags become subject + blank line + body, the conventional shape.
  const args = ['commit', '-m', trimmedSubject]
  if (body.trim()) args.push('-m', body)
  await git(rootPath, args)
  const sha = await git(rootPath, ['rev-parse', 'HEAD'])
  return sha.trim()
}
