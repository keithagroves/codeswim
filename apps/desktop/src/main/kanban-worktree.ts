// Manages the on-disk git worktrees used by Kanban's "Run all" — each card
// that runs gets an isolated checkout so parallel agent runs can't stomp on
// each other's file edits. Worktrees live outside the watched workspace tree
// (under userData, keyed by a hash of the workspace root) so they never show
// up in the file tree, diagram coverage, or the chokidar watcher.

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import {
  gitStatus,
  gitWorktreeAdd,
  gitWorktreeRemove,
  type GitWorktree
} from '@codeswim/domain-git'
import type { KanbanWorktreeInfo } from '@codeswim/contract'

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

// Every card worktree still on disk for this workspace, with a count of the
// uncommitted work inside it. Run all deliberately never commits — the agent's
// output sits in the worktree until the user syncs that card's branch — so this
// is what makes that work visible from the Sync panel instead of invisible
// under userData.
//
// Directories that are no longer valid worktrees (removed by hand, or left over
// from a crash) are skipped rather than reported as broken; `git worktree
// prune` in gitWorktreeRemove is the cleanup path.
export async function listCardWorktrees(rootPath: string): Promise<KanbanWorktreeInfo[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(worktreesRoot(rootPath))
  } catch {
    return [] // No worktrees have ever been created for this workspace.
  }

  const infos: KanbanWorktreeInfo[] = []
  for (const cardId of entries) {
    const dir = worktreePath(rootPath, cardId)
    try {
      const status = await gitStatus(dir)
      if (!status.isRepo) continue
      infos.push({
        cardId,
        path: dir,
        branch: status.branch,
        changeCount: status.staged.length + status.unstaged.length + status.untracked.length
      })
    } catch {
      continue
    }
  }
  return infos.sort((a, b) => a.cardId.localeCompare(b.cardId))
}
