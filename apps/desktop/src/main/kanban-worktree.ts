// Manages the on-disk git worktrees used by Kanban's "Run all" — each card
// that runs gets an isolated checkout so parallel agent runs can't stomp on
// each other's file edits. Worktrees live outside the watched workspace tree
// (under userData, keyed by a hash of the workspace root) so they never show
// up in the file tree, diagram coverage, or the chokidar watcher.

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { gitWorktreeAdd, gitWorktreeRemove, type GitWorktree } from '@codeswim/domain-git'

function worktreesRoot(rootPath: string): string {
  const hash = crypto.createHash('sha256').update(rootPath).digest('hex').slice(0, 16)
  return path.join(app.getPath('userData'), 'kanban-worktrees', hash)
}

function worktreePath(rootPath: string, cardId: string): string {
  return path.join(worktreesRoot(rootPath), cardId)
}

export async function createCardWorktree(
  rootPath: string,
  cardId: string,
  cardTitle: string
): Promise<GitWorktree> {
  const dir = worktreePath(rootPath, cardId)
  // A leftover directory from an interrupted previous run would make `git
  // worktree add` fail — we own this path exclusively, so clearing it first
  // is safe.
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(path.dirname(dir), { recursive: true })
  return gitWorktreeAdd(rootPath, dir, cardTitle)
}

export async function removeCardWorktree(rootPath: string, cardId: string): Promise<void> {
  await gitWorktreeRemove(rootPath, worktreePath(rootPath, cardId))
}
