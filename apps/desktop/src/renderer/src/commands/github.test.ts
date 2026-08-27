import { describe, expect, it, vi } from 'vitest'
import type { CommandOrigin, DiagramNavApi } from '@codeswim/contract'
import { CommandRegistry } from './registry'
import { registerGitHubCommands } from './github'
import type { CommandCtxFactory } from './context'
import type { AppState } from '../store'

const HUMAN: CommandOrigin = { kind: 'human' }
const AGENT: CommandOrigin = { kind: 'agent', sessionId: 's1', worktree: '/wt/card-1' }

interface Harness {
  registry: CommandRegistry
  api: {
    roomIdentity: ReturnType<typeof vi.fn>
    githubStatus: ReturnType<typeof vi.fn>
    githubToken: ReturnType<typeof vi.fn>
    githubSignIn: ReturnType<typeof vi.fn>
    githubSignOut: ReturnType<typeof vi.fn>
    listPullRequests: ReturnType<typeof vi.fn>
    mergePullRequest: ReturnType<typeof vi.fn>
  }
}

function makeHarness(): Harness {
  const api = {
    roomIdentity: vi.fn(async () => ({
      roomId: 'r1',
      publicRoomId: 'pr1',
      slug: 'owner/repo',
      provider: 'github' as const
    })),
    githubStatus: vi.fn(async () => ({ configured: true, user: null })),
    githubToken: vi.fn(async () => 'tok_abc'),
    githubSignIn: vi.fn(async () => ({
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device'
    })),
    githubSignOut: vi.fn(async () => {}),
    listPullRequests: vi.fn(async () => ({ status: 'ok' as const, slug: 'owner/repo', pulls: [] })),
    mergePullRequest: vi.fn(async () => ({ status: 'merged' as const }))
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
    planSync: async () => {
      throw new Error('not used')
    },
    commitGroup: async () => {
      throw new Error('not used')
    }
  })

  const registry = new CommandRegistry(buildCtx)
  registerGitHubCommands(registry)

  return { registry, api }
}

describe('read-only github commands', () => {
  it('github.roomIdentity / github.status / github.listPullRequests are agent-reachable', async () => {
    const h = makeHarness()
    await expect(
      h.registry.run('github.roomIdentity', { root: '/root' }, AGENT)
    ).resolves.toMatchObject({
      slug: 'owner/repo'
    })
    await expect(h.registry.run('github.status', {}, AGENT)).resolves.toMatchObject({
      configured: true
    })
    await expect(
      h.registry.run('github.listPullRequests', { root: '/root' }, AGENT)
    ).resolves.toMatchObject({ status: 'ok' })
  })

  it('github.listPullRequests passes an optional filter through', async () => {
    const h = makeHarness()
    await h.registry.run('github.listPullRequests', { root: '/root', filter: 'closed' }, HUMAN)
    expect(h.api.listPullRequests).toHaveBeenCalledWith('/root', 'closed')
  })
})

describe('privileged github commands are never agent-reachable', () => {
  it.each([
    ['github.token', {}],
    ['github.signIn', {}],
    ['github.signOut', {}],
    ['github.mergePullRequest', { root: '/root', number: 1 }]
  ] as const)('%s rejects an agent origin', async (id, args) => {
    const h = makeHarness()
    await expect(h.registry.run(id, args, AGENT)).rejects.toMatchObject({
      code: 'forbidden-origin'
    })
  })

  it('a human caller can still read the token, sign in/out, and merge', async () => {
    const h = makeHarness()
    await expect(h.registry.run('github.token', {}, HUMAN)).resolves.toBe('tok_abc')
    await expect(h.registry.run('github.signIn', {}, HUMAN)).resolves.toMatchObject({
      userCode: 'ABCD-1234'
    })
    await expect(h.registry.run('github.signOut', {}, HUMAN)).resolves.toBeUndefined()
    await expect(
      h.registry.run(
        'github.mergePullRequest',
        { root: '/root', number: 42, method: 'squash' },
        HUMAN
      )
    ).resolves.toMatchObject({ status: 'merged' })
    expect(h.api.mergePullRequest).toHaveBeenCalledWith('/root', 42, 'squash')
  })

  it('github.mergePullRequest has no danger gate (the row-level confirm UI is the review step)', async () => {
    const h = makeHarness()
    const confirmSpy = vi.fn()
    const registry = new CommandRegistry((origin) => ({
      getState: () => ({ rootPath: '/root' }) as unknown as AppState,
      dispatch: () => {},
      api: h.api as unknown as DiagramNavApi,
      toast: () => {},
      origin,
      activeRoot: '/root',
      executionRoot: '/root',
      confirm: async (_danger, summary) => {
        confirmSpy(summary)
        return true
      },
      startAgentInWorktree: async () => {},
      planSync: async () => {
        throw new Error('not used')
      },
      commitGroup: async () => {
        throw new Error('not used')
      }
    }))
    registerGitHubCommands(registry)
    await registry.run('github.mergePullRequest', { root: '/root', number: 1 }, HUMAN)
    expect(confirmSpy).not.toHaveBeenCalled()
  })
})
