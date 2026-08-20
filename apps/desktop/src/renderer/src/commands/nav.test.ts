import { describe, expect, it, vi } from 'vitest'
import type { CommandOrigin, DiagramNavApi } from '@codeswim/contract'
import { CommandRegistry } from './registry'
import { registerNavCommands } from './nav'
import type { CommandCtxFactory } from './context'
import type { AppState } from '../store'

const HUMAN: CommandOrigin = { kind: 'human' }
const AGENT: CommandOrigin = { kind: 'agent', sessionId: 's1', worktree: '/wt/card-1' }

interface Harness {
  registry: CommandRegistry
  dispatched: unknown[]
  readWorkspaceFile: ReturnType<typeof vi.fn>
  readSourceExplanation: ReturnType<typeof vi.fn>
  state: AppState
}

function makeHarness(overrides: Partial<AppState> = {}): Harness {
  const state: AppState = {
    rootPath: '/root',
    currentFile: 'overview.md',
    currentDocumentPath: 'overview.md',
    breadcrumbs: ['a.md', 'b.md'],
    forward: ['c.md'],
    ...overrides
  } as AppState

  const dispatched: unknown[] = []
  const readWorkspaceFile = vi.fn(async (_root: string, relPath: string) => `contents of ${relPath}`)
  const readSourceExplanation = vi.fn(async (_root: string, sourcePath: string) => ({
    sourcePath,
    documentPath: `.codeswim/explanations/${sourcePath}.md`,
    content: `explanation for ${sourcePath}`,
    exists: true
  }))

  const api = { readWorkspaceFile, readSourceExplanation } as unknown as DiagramNavApi

  const buildCtx: CommandCtxFactory = (origin) => ({
    getState: () => state,
    dispatch: (action) => dispatched.push(action),
    api,
    toast: () => {},
    origin,
    activeRoot: state.rootPath,
    executionRoot: origin.kind === 'agent' ? origin.worktree : state.rootPath,
    confirm: async () => true
  })

  const registry = new CommandRegistry(buildCtx)
  registerNavCommands(registry)
  return { registry, dispatched, readWorkspaceFile, readSourceExplanation, state }
}

describe('nav commands: traversal rejection', () => {
  it('rejects nav.navigateAbsolute for a relPath that escapes the root', async () => {
    const { registry, readWorkspaceFile } = makeHarness()
    await expect(
      registry.run('nav.navigateAbsolute', { relPath: '../../etc/passwd', pushBreadcrumb: true }, HUMAN)
    ).rejects.toMatchObject({ code: 'invalid-args' })
    expect(readWorkspaceFile).not.toHaveBeenCalled()
  })

  it('rejects nav.openSourceCode for an absolute relPath', async () => {
    const { registry, readWorkspaceFile } = makeHarness()
    await expect(
      registry.run('nav.openSourceCode', { relPath: '/etc/passwd', range: null }, HUMAN)
    ).rejects.toMatchObject({ code: 'invalid-args' })
    expect(readWorkspaceFile).not.toHaveBeenCalled()
  })

  it('rejects nav.navigateRelative when the *resolved* path escapes the root, even though the raw ".." target is ordinary', async () => {
    const { registry, readWorkspaceFile, readSourceExplanation } = makeHarness({
      currentDocumentPath: 'top-level.md'
    })
    // From a top-level file, "../secret.md" resolves above the root.
    await expect(
      registry.run('nav.navigateRelative', { target: '../secret.md' }, HUMAN)
    ).rejects.toMatchObject({ code: 'invalid-args' })
    expect(readWorkspaceFile).not.toHaveBeenCalled()
    expect(readSourceExplanation).not.toHaveBeenCalled()
  })

  it('accepts an ordinary ".." target that stays inside the root', async () => {
    const { registry, dispatched } = makeHarness({ currentDocumentPath: 'billing/charge-flow.md' })
    await registry.run('nav.navigateRelative', { target: '../shared/db.md' }, HUMAN)
    const loadSuccess = dispatched.find((a) => (a as { type: string }).type === 'load-success') as {
      file: string
    }
    expect(loadSuccess.file).toBe('shared/db.md')
  })
})

describe('nav commands: happy path', () => {
  it('nav.navigateAbsolute reads via the root-scoped api and dispatches load-success', async () => {
    const { registry, dispatched, readWorkspaceFile } = makeHarness()
    await registry.run('nav.navigateAbsolute', { relPath: 'architecture/auth.md', pushBreadcrumb: true }, HUMAN)
    expect(readWorkspaceFile).toHaveBeenCalledWith('/root', 'architecture/auth.md')
    expect(dispatched.some((a) => (a as { type: string }).type === 'load-success')).toBe(true)
  })

  it('uses the agent origin worktree as the execution root, not the human root', async () => {
    const { registry, readWorkspaceFile } = makeHarness()
    await registry.run('nav.navigateAbsolute', { relPath: 'card.md', pushBreadcrumb: true }, AGENT)
    expect(readWorkspaceFile).toHaveBeenCalledWith('/wt/card-1', 'card.md')
  })

  it('nav.setWorkspaceView dispatches set-workspace-view', async () => {
    const { registry, dispatched } = makeHarness()
    await registry.run('nav.setWorkspaceView', { view: 'kanban' }, HUMAN)
    expect(dispatched).toEqual([{ type: 'set-workspace-view', view: 'kanban' }])
  })

  it('nav.popTo rejects an out-of-range index as a no-op, not an error', async () => {
    const { registry, dispatched } = makeHarness()
    await registry.run('nav.popTo', { index: 99 }, HUMAN)
    expect(dispatched).toEqual([])
  })

  it('nav.popTo, nav.goBack, nav.goForward are not agent-reachable', async () => {
    const { registry } = makeHarness()
    await expect(registry.run('nav.popTo', { index: 0 }, AGENT)).rejects.toMatchObject({
      code: 'forbidden-origin'
    })
    await expect(registry.run('nav.goBack', {}, AGENT)).rejects.toMatchObject({
      code: 'forbidden-origin'
    })
    await expect(registry.run('nav.goForward', {}, AGENT)).rejects.toMatchObject({
      code: 'forbidden-origin'
    })
  })
})
