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

// Unstage everything, leaving the working tree untouched. `git reset` needs a
// HEAD to reset the index against; a repo with no commits yet has none, so we
// clear the index directly in that case (still keeps the files on disk).
export async function gitUnstageAll(rootPath: string): Promise<void> {
  let hasHead = true
  try {
    await git(rootPath, ['rev-parse', '--verify', 'HEAD'])
  } catch {
    hasHead = false
  }
  if (hasHead) {
    await git(rootPath, ['reset', '--quiet'])
  } else {
    await git(rootPath, ['rm', '-r', '--cached', '--quiet', '.'])
  }
}

// The push/fetch URL of the `origin` remote, or null when there's no origin
// (local-only repo, or not a repo). Used to derive a stable chat-room ID that
// two clones of the same repo agree on without any central registry.
export async function gitRemoteUrl(rootPath: string): Promise<string | null> {
  try {
    const out = await git(rootPath, ['remote', 'get-url', 'origin'])
    return out.trim() || null
  } catch {
    // No origin configured, or not a repo — both mean "no shared room".
    return null
  }
}

export async function gitStagedDiff(rootPath: string): Promise<string> {
  // --staged shows what `git commit` would record. No color, full context.
  return git(rootPath, ['diff', '--staged', '--no-color'])
}

// The whole working picture for the Sync triage: every tracked change vs HEAD
// (staged or not) plus newly added files. `git add -N` records untracked files
// as intent-to-add so `git diff HEAD` includes them, then we undo the intent so
// the index is left exactly as we found it — triage is a read-only inspection.
//
// On a repo with no commits yet there's no HEAD to diff against, so we fall
// back to diffing the empty tree (every file reads as an addition).
export async function gitWorkingDiff(rootPath: string): Promise<string> {
  const untracked = (await git(rootPath, ['ls-files', '--others', '--exclude-standard', '-z']))
    .split('\0')
    .filter((p) => p.length > 0)

  if (untracked.length > 0) {
    await git(rootPath, ['add', '-N', '--', ...untracked])
  }
  try {
    let hasHead = true
    try {
      await git(rootPath, ['rev-parse', '--verify', 'HEAD'])
    } catch {
      hasHead = false
    }
    const base = hasHead
      ? ['diff', 'HEAD', '--no-color']
      : // 4b825dc… is git's canonical empty-tree object: diffing against it
        // makes the very first commit's files show up as additions.
        ['diff', '--no-color', '4b825dc642cb6eb9a060e54bf8d69288fbee4904']
    return await git(rootPath, base)
  } finally {
    // Drop the intent-to-add marks regardless of how the diff went.
    if (untracked.length > 0) {
      await git(rootPath, ['reset', '--quiet', '--', ...untracked]).catch(() => {})
    }
  }
}

// The diff for a single path, for the main-panel diff viewer. Shows the working
// state vs the last commit (staged + unstaged together), so what the user sees
// matches what Sync would save. Untracked files are shown as full additions via
// the same intent-to-add trick as gitWorkingDiff, undone afterward. Falls back
// to the empty tree on a repo with no commits yet.
export async function gitFileDiff(rootPath: string, filePath: string): Promise<string> {
  let hasHead = true
  try {
    await git(rootPath, ['rev-parse', '--verify', 'HEAD'])
  } catch {
    hasHead = false
  }
  const base = hasHead ? 'HEAD' : '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

  // Untracked files don't appear in `git diff HEAD`; record intent-to-add so the
  // new file reads as an addition, then undo it (this is a read-only view).
  let tracked = true
  try {
    await git(rootPath, ['ls-files', '--error-unmatch', '--', filePath])
  } catch {
    tracked = false
  }
  let markedIntent = false
  if (!tracked) {
    try {
      await git(rootPath, ['add', '-N', '--', filePath])
      markedIntent = true
    } catch {
      // Ignored or otherwise unaddable — nothing to show as a tracked diff.
    }
  }
  try {
    return await git(rootPath, ['diff', base, '--no-color', '--', filePath])
  } finally {
    if (markedIntent) {
      await git(rootPath, ['reset', '--quiet', '--', filePath]).catch(() => {})
    }
  }
}

// Commit exactly the given paths as one isolated commit: clear the index, stage
// just this group (`add -A` so deletions and additions both land), then commit.
// Sequential calls from the panel each produce a clean, single-purpose commit.
// Which of these paths match the .gitignore rules, evaluated by RULE — not by
// tracked status. `--no-index` is the key: plain `check-ignore` reports a
// tracked file as not-ignored, but we need the rule view, because `git add`
// refuses ANY ignored path (even a tracked, modified, or deleted one). So we
// route ignored paths to removal instead of add. Returns a Set for O(1) lookup.
async function ignoredByRule(rootPath: string, paths: string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set()
  let out: string
  try {
    // NB: `-z` is rejected unless paired with `--stdin`, so we parse newline
    // output instead — fine, since our paths come from git's own porcelain.
    out = await git(rootPath, ['check-ignore', '--no-index', '--', ...paths])
  } catch {
    // Exit 1 = none ignored (our git() wrapper throws on non-zero). Treat any
    // failure as "nothing ignored" so a missing check-ignore can't block a save.
    return new Set()
  }
  return new Set(
    out
      .split(/\r?\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
  )
}

// Whether the index has anything staged (vs HEAD, or the empty tree on a fresh
// repo). `git diff --cached --quiet` exits non-zero exactly when there is.
async function indexHasStagedChanges(rootPath: string): Promise<boolean> {
  try {
    await git(rootPath, ['diff', '--cached', '--quiet'])
    return false
  } catch {
    return true
  }
}

export async function gitCommitGroup(
  rootPath: string,
  paths: string[],
  subject: string,
  body: string
): Promise<string> {
  const trimmedSubject = subject.trim()
  if (!trimmedSubject) throw new Error('commit subject is empty')
  if (paths.length === 0) throw new Error('no files in this commit group')

  await gitUnstageAll(rootPath)

  // Split the group: ignored paths can't be `git add`ed, so we stage them as
  // removals (stop tracking) — `rm --cached --ignore-unmatch` no-ops on the
  // ones that were never tracked. Everything else stages with `add -A`, which
  // covers additions, edits, and deletions of non-ignored files.
  const ignored = await ignoredByRule(rootPath, paths)
  const addable = paths.filter((p) => !ignored.has(p))
  const removable = paths.filter((p) => ignored.has(p))

  if (addable.length > 0) {
    await git(rootPath, ['add', '-A', '--', ...addable])
  }
  if (removable.length > 0) {
    await git(rootPath, ['rm', '-r', '--cached', '--ignore-unmatch', '--', ...removable])
  }

  // If the whole group was ignored-and-untracked, nothing landed in the index.
  // Bail with a friendly message rather than letting `git commit` error.
  if (!(await indexHasStagedChanges(rootPath))) {
    throw new Error('Nothing in this commit needs saving — those files are ignored.')
  }

  const args = ['commit', '-m', trimmedSubject]
  if (body.trim()) args.push('-m', body)
  await git(rootPath, args)
  const sha = await git(rootPath, ['rev-parse', 'HEAD'])
  return sha.trim()
}

export interface GitIgnoreResult {
  // Patterns we actually appended (ones already present are skipped).
  added: string[]
  // Paths we had to `git rm --cached` because they were already tracked —
  // adding them to .gitignore alone wouldn't stop tracking them.
  untracked: string[]
}

// Append patterns to .gitignore (creating it if absent), de-duplicating against
// what's already there, and stop tracking any path that git already follows so
// the ignore actually takes effect. Used by the Sync triage's "ignore instead"
// guardrail for secrets / build output / large blobs.
export async function gitAddToGitignore(
  rootPath: string,
  patterns: string[]
): Promise<GitIgnoreResult> {
  const clean = patterns.map((p) => p.trim()).filter((p) => p.length > 0)
  if (clean.length === 0) return { added: [], untracked: [] }

  const file = path.join(rootPath, '.gitignore')
  let existing = ''
  try {
    existing = await fs.readFile(file, 'utf-8')
  } catch {
    // No .gitignore yet — we'll create one.
  }
  const present = new Set(
    existing
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'))
  )
  const added = clean.filter((p) => !present.has(p))
  if (added.length > 0) {
    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
    const block = `${prefix}\n# Added by codeswim sync\n${added.join('\n')}\n`
    await fs.appendFile(file, block, 'utf-8')
  }

  // Stop tracking anything that matches and is already tracked. `git rm
  // --cached` removes it from the index but leaves it on disk.
  const untracked: string[] = []
  for (const p of clean) {
    try {
      await git(rootPath, ['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--', p])
      untracked.push(p)
    } catch {
      // Not tracked (or no match) — the .gitignore entry alone suffices.
    }
  }
  return { added, untracked }
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

export interface GitCommitEntry {
  hash: string
  shortHash: string
  author: string
  date: string // ISO 8601
  subject: string
  body: string // full body, including any trailers
  // Whether the body carries our Codeswim-Synthesized: true trailer.
  synthesized: boolean
}

// Field/record separators: control chars that won't appear in real commit
// metadata, so we can split unambiguously even when bodies contain newlines.
const LOG_FIELD = '\u001f'
const LOG_RECORD = '\u001e'

// Pure parser for the custom `git log` format below. Exported for testing.
export function parseGitLog(raw: string): GitCommitEntry[] {
  return (
    raw
      .split(LOG_RECORD)
      // git joins records with a newline; strip the leading one off each.
      .map((r) => r.replace(/^\n+/, ''))
      .filter((r) => r.trim().length > 0)
      .map((rec) => {
        const parts = rec.split(LOG_FIELD)
        const hash = (parts[0] ?? '').trim()
        const body = (parts[4] ?? '').trim()
        return {
          hash,
          shortHash: hash.slice(0, 7),
          author: parts[1] ?? '',
          date: parts[2] ?? '',
          subject: parts[3] ?? '',
          body,
          synthesized: /^Codeswim-Synthesized:\s*true\s*$/m.test(body)
        }
      })
      .filter((c) => c.hash.length > 0)
  )
}

export async function gitLog(rootPath: string, limit = 100): Promise<GitCommitEntry[]> {
  const fmt = ['%H', '%an', '%aI', '%s', '%b'].join(LOG_FIELD) + LOG_RECORD
  let out: string
  try {
    out = await git(rootPath, [
      'log',
      '-n',
      String(Math.max(1, Math.min(limit, 1000))),
      '--pretty=format:' + fmt
    ])
  } catch (err) {
    // Fresh repo with no commits yet, or not a repo — both mean "no history".
    const msg = err instanceof Error ? err.message : String(err)
    if (/does not have any commits|not a git repository|bad default revision/i.test(msg)) {
      return []
    }
    throw err
  }
  return parseGitLog(out)
}
