import { describe, expect, it, vi } from 'vitest'
import type { CommandOrigin, DiagramNavApi, GitStatus, GitSyncResult } from '@codeswim/contract'
import type { SyncPlan } from '@codeswim/commit'
import { CommandRegistry } from './registry'
import { registerGitCommands, flattenChanges } from './git'
import type { CommandCtxFactory } from './context'
import type { AppState } from '../store'

const HUMAN: CommandOrigin = { kind: 'human' }
const AGENT: CommandOrigin = { kind: 'agent', sessionId: 's1', worktree: '/wt/card-1' }

function gitStatus(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    isRepo: true,
    branch: 'main',
    staged: [],
    unstaged: [{ path: 'a.ts', worktree: 'M', index: ' ' }],
    untracked: [],
    clean: false,
    ...overrides
  }
}

function syncPlan(overrides: Partial<SyncPlan> = {}): SyncPlan {
  return {
    summary: 'Updated things',
    obvious: true,
    groups: [{ subject: 'Update a.ts', body: '', paths: ['a.ts'] }],
    ignore: [],
    ...overrides
  }
}

interface Harness {
  registry: CommandRegistry
  planSyncMock: ReturnType<typeof vi.fn>
  commitGroupMock: ReturnType<typeof vi.fn>
  api: {
    gitStatus: ReturnType<typeof vi.fn>
    gitLog: ReturnType<typeof vi.fn>
    gitInit: ReturnType<typeof vi.fn>
    gitWorkingDiff: ReturnType<typeof vi.fn>
    gitPush: ReturnType<typeof vi.fn>
    listTree: ReturnType<typeof vi.fn>
    readFile: ReturnType<typeof vi.fn>
  }
}

function makeHarness(): Harness {
  const planSyncMock = vi.fn(async (): Promise<SyncPlan> => syncPlan())
  const commitGroupMock = vi.fn(async () => 'sha123')

  const api = {
    gitStatus: vi.fn(async () => gitStatus()),
    gitLog: vi.fn(async () => []),
    gitInit: vi.fn(async () => ({ createdGitignore: true })),
    gitWorkingDiff: vi.fn(async () => 'diff --git a/a.ts b/a.ts'),
    gitPush: vi.fn(
      async (): Promise<GitSyncResult> => ({
        remote: true,
        pushed: true,
        branch: 'main',
        conflict: false
      })
    ),
    listTree: vi.fn(async () => []),
    readFile: vi.fn(async () => '')
  }

  const state: AppState = { rootPath: '/root' } as AppState

  const buildCtx: CommandCtxFactory = (origin) => ({
    getState: () => state,
    dispatch: () => {},
    api: api as unknown as DiagramNavApi,
    toast: () => {},
    origin,
    activeRoot: state.rootPath,
    executionRoot: origin.kind === 'agent' ? origin.worktree : state.rootPath,
    confirm: async () => true,
    startAgentInWorktree: async () => {},
    planSync: planSyncMock,
    commitGroup: commitGroupMock
  })

  const registry = new CommandRegistry(buildCtx)
  registerGitCommands(registry)

  return { registry, planSyncMock, commitGroupMock, api }
}

describe('flattenChanges', () => {
  it('collapses staged/unstaged/untracked into one list with plain-language verbs', () => {
    const changes = flattenChanges(
      gitStatus({
        staged: [{ path: 'b.ts', worktree: ' ', index: 'A' }],
        unstaged: [{ path: 'a.ts', worktree: 'M', index: ' ' }],
        untracked: ['c.ts']
      })
    )
    expect(changes).toEqual([
      { path: 'a.ts', verb: 'edited' },
      { path: 'b.ts', verb: 'added' },
      { path: 'c.ts', verb: 'new' }
    ])
  })

  it('staged status wins over worktree status for the same path', () => {
    const changes = flattenChanges(
      gitStatus({
        staged: [{ path: 'a.ts', worktree: ' ', index: 'A' }],
        unstaged: [{ path: 'a.ts', worktree: 'M', index: ' ' }],
        untracked: []
      })
    )
    expect(changes).toEqual([{ path: 'a.ts', verb: 'added' }])
  })
})

describe('git.refreshStatus / git.loadHistory', () => {
  it('are agent-reachable read-only commands', async () => {
    const h = makeHarness()
    await expect(
      h.registry.run('git.refreshStatus', { dir: '/root' }, AGENT)
    ).resolves.toMatchObject({
      isRepo: true
    })
    await expect(
      h.registry.run('git.loadHistory', { dir: '/root', limit: 50 }, AGENT)
    ).resolves.toEqual([])
    expect(h.api.gitLog).toHaveBeenCalledWith('/root', 50)
  })
})

describe('git.init', () => {
  it('is not agent-reachable and requires no extra confirmation', async () => {
    const h = makeHarness()
    await expect(h.registry.run('git.init', { root: '/root' }, AGENT)).rejects.toMatchObject({
      code: 'forbidden-origin'
    })
    const result = await h.registry.run('git.init', { root: '/root' }, HUMAN)
    expect(result).toEqual({ createdGitignore: true })
    expect(h.api.gitInit).toHaveBeenCalledWith('/root')
  })
})

describe('git.sync', () => {
  it('is never agent-reachable', async () => {
    const h = makeHarness()
    await expect(
      h.registry.run('git.sync', { dir: '/root', isCardTarget: false }, AGENT)
    ).rejects.toMatchObject({ code: 'forbidden-origin' })
  })

  it('skips the coverage gate for a card-worktree target', async () => {
    const h = makeHarness()
    await h.registry.run('git.sync', { dir: '/wt/card-1', isCardTarget: true }, HUMAN)
    expect(h.api.listTree).not.toHaveBeenCalled()
  })

  it('reports nothing-changed when the working tree is clean', async () => {
    const h = makeHarness()
    h.api.gitStatus.mockResolvedValue(gitStatus({ unstaged: [], staged: [], untracked: [] }))
    const outcome = await h.registry.run('git.sync', { dir: '/root', isCardTarget: true }, HUMAN)
    expect(outcome).toEqual({ kind: 'nothing-changed' })
  })

  it('auto-commits and pushes an obvious plan, returning done', async () => {
    const h = makeHarness()
    const outcome = await h.registry.run('git.sync', { dir: '/root', isCardTarget: true }, HUMAN)
    expect(outcome).toMatchObject({
      kind: 'done',
      commits: [{ subject: 'Update a.ts', sha: 'sha123' }],
      sync: { pushed: true }
    })
    expect(h.commitGroupMock).toHaveBeenCalledWith(['a.ts'], 'Update a.ts', '', '/root')
  })

  it('hands a non-obvious plan back for review instead of committing', async () => {
    const h = makeHarness()
    h.planSyncMock.mockResolvedValue(syncPlan({ obvious: false }))
    const outcome = await h.registry.run('git.sync', { dir: '/root', isCardTarget: true }, HUMAN)
    expect(outcome).toMatchObject({ kind: 'plan' })
    expect(h.commitGroupMock).not.toHaveBeenCalled()
  })

  it('falls back to a single catch-all group when the agent returns no usable groups', async () => {
    const h = makeHarness()
    h.planSyncMock.mockResolvedValue(
      syncPlan({ groups: [], ignore: [], summary: 'Cleaned up', obvious: true })
    )
    const outcome = await h.registry.run('git.sync', { dir: '/root', isCardTarget: true }, HUMAN)
    expect(outcome).toMatchObject({ kind: 'plan', plan: { groups: [{ subject: 'Cleaned up' }] } })
  })

  // The coverage-gate's own report shaping (broken links, orphan diagrams,
  // mermaid issues) is runCoverage/analyzeCoverage's concern, exercised by
  // their own test suites — the "skips the coverage gate for a card-worktree
  // target" test above is what proves git.sync wires isCardTarget through
  // correctly.
})

describe('git.commitPlan', () => {
  it('is never agent-reachable', async () => {
    const h = makeHarness()
    await expect(
      h.registry.run('git.commitPlan', { dir: '/root', plan: syncPlan() }, AGENT)
    ).rejects.toMatchObject({ code: 'forbidden-origin' })
  })

  it('commits every group in order and pushes once', async () => {
    const h = makeHarness()
    const plan = syncPlan({
      groups: [
        { subject: 'First', body: '', paths: ['a.ts'] },
        { subject: 'Second', body: '', paths: ['b.ts'] }
      ]
    })
    const result = await h.registry.run<{
      commits: Array<{ subject: string; sha: string }>
      sync: GitSyncResult
    }>('git.commitPlan', { dir: '/root', plan }, HUMAN)
    expect(result.commits.map((c) => c.subject)).toEqual(['First', 'Second'])
    expect(h.commitGroupMock).toHaveBeenCalledTimes(2)
    expect(h.api.gitPush).toHaveBeenCalledWith('/root')
    expect(result.sync.pushed).toBe(true)
  })

  it('still reports the commits as done when the push fails', async () => {
    const h = makeHarness()
    h.api.gitPush.mockRejectedValue(new Error('offline'))
    const result = await h.registry.run<{
      commits: Array<{ subject: string; sha: string }>
      sync: GitSyncResult
    }>('git.commitPlan', { dir: '/root', plan: syncPlan() }, HUMAN)
    expect(result.commits).toHaveLength(1)
    expect(result.sync).toMatchObject({ pushed: false, error: 'offline' })
  })
})
