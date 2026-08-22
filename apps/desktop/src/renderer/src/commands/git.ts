import type { GitCommitEntry, GitInitResult, GitStatus, GitSyncResult } from '@codeswim/contract'
import type { SyncPlan } from '@codeswim/commit'
import type { CoverageReport } from '@codeswim/coverage'
import { runCoverage } from '../coverage/run'
import type { CommandCtx } from './context'
import type { CommandRegistry } from './registry'

// Collapse git's staged/unstaged/untracked split into a single list the UI
// can read: one row per path with a plain-language verb. Staged wins over
// worktree for the verb, untracked reads as "new". Exported so GitPanel's
// render (the file list, arrow-key nav) shares the exact same shaping as
// git.sync's own change-count check.
export interface SimpleChange {
  path: string
  verb: string
}

function changeVerb(code: string): string {
  switch (code) {
    case 'A':
      return 'added'
    case 'M':
      return 'edited'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    case '?':
      return 'new'
    default:
      return 'changed'
  }
}

export function flattenChanges(git: GitStatus): SimpleChange[] {
  const byPath = new Map<string, string>()
  for (const f of git.unstaged) byPath.set(f.path, changeVerb(f.worktree))
  for (const f of git.staged) byPath.set(f.path, changeVerb(f.index))
  for (const p of git.untracked) byPath.set(p, 'new')
  return [...byPath.entries()]
    .map(([path, verb]) => ({ path, verb }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

function coverageIssueCount(r: CoverageReport): number {
  return (
    r.brokenLinks.length +
    r.orphanDiagrams.length +
    r.uncoveredSources.length +
    r.mermaidIssues.length
  )
}

export interface GitRefreshStatusArgs {
  dir: string
}

export interface GitLoadHistoryArgs {
  dir: string
  limit: number
}

export interface GitInitArgs {
  root: string
}

export type GitSyncOutcome =
  | { kind: 'nothing-changed' }
  | { kind: 'blocked'; report: CoverageReport }
  | { kind: 'plan'; plan: SyncPlan }
  | { kind: 'done'; commits: Array<{ subject: string; sha: string }>; sync: GitSyncResult }

export interface GitSyncArgs {
  dir: string
  // A card worktree is reviewed (and coverage-gated) when it lands back on
  // the workspace, not while it's running — see GitPanel's onSync for the
  // original reasoning. `true` skips the coverage gate for this call.
  isCardTarget: boolean
  instruction?: string
}

export interface GitCommitPlanArgs {
  dir: string
  plan: SyncPlan
}

// Commits every group in a plan, sequentially, then backs the commits up to
// the remote (pull + push). The commits are saved locally before the network
// is touched, so a failed/absent push never loses the user's work.
async function doCommitPlan(
  args: GitCommitPlanArgs,
  ctx: CommandCtx
): Promise<{ commits: Array<{ subject: string; sha: string }>; sync: GitSyncResult }> {
  const done: Array<{ subject: string; sha: string }> = []
  for (const g of args.plan.groups) {
    const sha = await ctx.commitGroup(g.paths, g.subject, g.body, args.dir)
    done.push({ subject: g.subject, sha })
  }
  let sync: GitSyncResult
  try {
    sync = await ctx.api.gitPush(args.dir)
  } catch (err) {
    sync = {
      remote: true,
      pushed: false,
      branch: null,
      conflict: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
  return { commits: done, sync }
}

// The Sync button's flow: coverage-gates first (for diagram repos, workspace
// target only), then asks the agent to triage the working diff. An obvious,
// safe change commits itself; anything else is handed back for review.
async function doSync(args: GitSyncArgs, ctx: CommandCtx): Promise<GitSyncOutcome> {
  if (!args.isCardTarget) {
    const report = await runCoverage(args.dir)
    if (report.totals.diagrams > 0 && coverageIssueCount(report) > 0) {
      return { kind: 'blocked', report }
    }
  }

  const status = await ctx.api.gitStatus(args.dir)
  const diff = await ctx.api.gitWorkingDiff(args.dir)
  const changes = flattenChanges(status)
  if (changes.length === 0) {
    return { kind: 'nothing-changed' }
  }
  const changedPaths = changes.map((c) => c.path)

  let plan = await ctx.planSync(diff, changedPaths, args.instruction)
  // The agent sometimes returns no usable groups (e.g. it lumped everything
  // under "ignore", or named paths that didn't match). Never dead-end when
  // there are real changes — fall back to a single catch-all commit the user
  // can review and reword. Drop any path it flagged to ignore.
  if (plan.groups.length === 0) {
    const ignored = new Set(plan.ignore.map((i) => i.pattern))
    const remaining = changedPaths.filter((p) => !ignored.has(p))
    if (remaining.length === 0) {
      return { kind: 'plan', plan }
    }
    plan = {
      ...plan,
      obvious: false,
      groups: [{ subject: plan.summary || 'Update files', body: plan.summary, paths: remaining }]
    }
  }

  if (plan.obvious) {
    const result = await doCommitPlan({ dir: args.dir, plan }, ctx)
    return { kind: 'done', ...result }
  }
  return { kind: 'plan', plan }
}

export function registerGitCommands(registry: CommandRegistry): void {
  registry.register<GitRefreshStatusArgs, GitStatus>({
    id: 'git.refreshStatus',
    domain: 'git',
    title: 'Refresh git status',
    description: 'Reads the working-tree status (staged/unstaged/untracked) for a directory.',
    schema: { type: 'object', required: ['dir'], properties: { dir: { type: 'string' } } },
    agent: 'listed',
    run: (args, ctx) => ctx.api.gitStatus(args.dir)
  })

  registry.register<GitLoadHistoryArgs, GitCommitEntry[]>({
    id: 'git.loadHistory',
    domain: 'git',
    title: 'Load commit history',
    description: 'Reads recent commit history for a directory.',
    schema: {
      type: 'object',
      required: ['dir', 'limit'],
      properties: { dir: { type: 'string' }, limit: { type: 'number' } }
    },
    agent: 'listed',
    run: (args, ctx) => ctx.api.gitLog(args.dir, args.limit)
  })

  registry.register<GitInitArgs, GitInitResult>({
    id: 'git.init',
    domain: 'git',
    title: 'Initialize repository',
    description:
      'Initializes a git repository at the workspace root, adding a sensible .gitignore.',
    schema: { type: 'object', required: ['root'], properties: { root: { type: 'string' } } },
    // No danger gate: "Start tracking" is already the explicit user action
    // (no prior ad hoc confirm existed here either) — an extra confirm would
    // just be double-asking.
    agent: 'never',
    run: (args, ctx) => ctx.api.gitInit(args.root)
  })

  registry.register<GitSyncArgs, GitSyncOutcome>({
    id: 'git.sync',
    domain: 'git',
    title: 'Sync',
    description: "Triages the working diff with the agent and commits what's obviously safe.",
    schema: {
      type: 'object',
      required: ['dir', 'isCardTarget'],
      properties: {
        dir: { type: 'string' },
        isCardTarget: { type: 'boolean' },
        instruction: { type: 'string', nullable: true }
      }
    },
    agent: 'never',
    run: doSync
  })

  registry.register<
    GitCommitPlanArgs,
    { commits: Array<{ subject: string; sha: string }>; sync: GitSyncResult }
  >({
    id: 'git.commitPlan',
    domain: 'git',
    title: 'Commit plan',
    description: 'Commits every group in a sync plan, then pushes.',
    schema: {
      type: 'object',
      required: ['dir', 'plan'],
      properties: { dir: { type: 'string' }, plan: { type: 'object' } }
    },
    // No danger gate: PlanReview is already the review step (the user sees
    // every commit group before pressing Save) — an extra confirm on top of
    // that reviewed click would just be double-asking.
    agent: 'never',
    run: doCommitPlan
  })
}
