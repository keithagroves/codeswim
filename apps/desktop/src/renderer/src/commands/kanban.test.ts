import { describe, expect, it, vi } from 'vitest'
import type { CommandOrigin, DiagramNavApi, KanbanBoard, KanbanCard } from '@codeswim/contract'
import { CommandRegistry, CommandRegistryError } from './registry'
import { registerKanbanCommands } from './kanban'
import type { CommandCtxFactory } from './context'
import type { AppState } from '../store'

const HUMAN: CommandOrigin = { kind: 'human' }
const AGENT: CommandOrigin = { kind: 'agent', sessionId: 's1', worktree: '/wt/card-1' }

function card(id: string, columnId: string, overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id,
    title: `Card ${id}`,
    description: '',
    columnId,
    priority: 'medium',
    labels: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

function board(cards: KanbanCard[], overrides: Partial<KanbanBoard> = {}): KanbanBoard {
  return {
    version: 1,
    title: 'Board',
    columns: [
      { id: 'todo', name: 'To do', color: '#000' },
      { id: 'doing', name: 'Doing', color: '#000' },
      { id: 'done', name: 'Done', color: '#000' }
    ],
    cards,
    ...overrides
  }
}

interface Harness {
  registry: CommandRegistry
  toasts: string[]
  confirmResult: boolean
  confirmCalls: string[]
  startedAgents: Array<{ cardId: string; directory: string }>
  api: {
    kanbanRead: ReturnType<typeof vi.fn>
    kanbanWrite: ReturnType<typeof vi.fn>
    kanbanGitHubSync: ReturnType<typeof vi.fn>
    kanbanGitHubMove: ReturnType<typeof vi.fn>
    kanbanWorktreeCreate: ReturnType<typeof vi.fn>
    gitStatus: ReturnType<typeof vi.fn>
    gitInit: ReturnType<typeof vi.fn>
    gitStageAll: ReturnType<typeof vi.fn>
    gitCommit: ReturnType<typeof vi.fn>
  }
}

function makeHarness(opts: { confirmResult?: boolean } = {}): Harness {
  const toasts: string[] = []
  const confirmCalls: string[] = []
  const startedAgents: Array<{ cardId: string; directory: string }> = []
  const confirmResult = opts.confirmResult ?? true

  const api = {
    kanbanRead: vi.fn(),
    kanbanWrite: vi.fn(async (_root: string, next: KanbanBoard) => next),
    kanbanGitHubSync: vi.fn(),
    kanbanGitHubMove: vi.fn(async () => {}),
    kanbanWorktreeCreate: vi.fn(async (_root: string, cardId: string) => ({
      path: `/wt/${cardId}`,
      branch: `card/${cardId}`
    })),
    gitStatus: vi.fn(async () => ({ isRepo: true })),
    gitInit: vi.fn(async () => ({})),
    gitStageAll: vi.fn(async () => {}),
    gitCommit: vi.fn(async () => 'sha')
  }

  const state: AppState = { rootPath: '/root' } as AppState

  const buildCtx: CommandCtxFactory = (origin) => ({
    getState: () => state,
    dispatch: () => {},
    api: api as unknown as DiagramNavApi,
    toast: (message) => toasts.push(message),
    origin,
    activeRoot: state.rootPath,
    executionRoot: origin.kind === 'agent' ? origin.worktree : state.rootPath,
    confirm: async (_danger, summary) => {
      confirmCalls.push(summary)
      return confirmResult
    },
    startAgentInWorktree: async (c, directory) => {
      startedAgents.push({ cardId: c.id, directory })
    },
    planSync: async () => {
      throw new Error('not used by kanban commands')
    },
    commitGroup: async () => {
      throw new Error('not used by kanban commands')
    }
  })

  const registry = new CommandRegistry(buildCtx)
  registerKanbanCommands(registry)

  return { registry, toasts, confirmResult, confirmCalls, startedAgents, api }
}

describe('kanban.load', () => {
  it('reads the board for the workspace root', async () => {
    const h = makeHarness()
    const b = board([])
    h.api.kanbanRead.mockResolvedValue(b)
    const result = await h.registry.run<KanbanBoard | null>('kanban.load', { root: '/root' }, HUMAN)
    expect(result).toBe(b)
    expect(h.api.kanbanRead).toHaveBeenCalledWith('/root')
  })

  it('toasts and returns null on read failure', async () => {
    const h = makeHarness()
    h.api.kanbanRead.mockRejectedValue(new Error('boom'))
    const result = await h.registry.run<KanbanBoard | null>('kanban.load', { root: '/root' }, HUMAN)
    expect(result).toBeNull()
    expect(h.toasts.some((t) => t.includes('Could not load board'))).toBe(true)
  })

  it('is agent-reachable (read-only)', async () => {
    const h = makeHarness()
    h.api.kanbanRead.mockResolvedValue(board([]))
    await expect(h.registry.run('kanban.load', { root: '/root' }, AGENT)).resolves.not.toThrow()
  })
})

describe('kanban.save', () => {
  it('writes the board and returns the saved result', async () => {
    const h = makeHarness()
    const b = board([card('1', 'todo')])
    const result = await h.registry.run<KanbanBoard | null>('kanban.save', { board: b }, HUMAN)
    expect(result).toEqual(b)
    expect(h.api.kanbanWrite).toHaveBeenCalledWith('/root', b)
  })

  it('is not agent-reachable', async () => {
    const h = makeHarness()
    await expect(h.registry.run('kanban.save', { board: board([]) }, AGENT)).rejects.toMatchObject({
      code: 'forbidden-origin'
    })
  })

  it('falls back to a fresh load and toasts on write failure', async () => {
    const h = makeHarness()
    h.api.kanbanWrite.mockRejectedValue(new Error('disk full'))
    const fallback = board([])
    h.api.kanbanRead.mockResolvedValue(fallback)
    const result = await h.registry.run<KanbanBoard | null>(
      'kanban.save',
      { board: board([]) },
      HUMAN
    )
    expect(result).toBe(fallback)
    expect(h.toasts.some((t) => t.includes('Could not save board'))).toBe(true)
  })
})

describe('kanban.moveCard', () => {
  it('moves a card to a new column and persists', async () => {
    const h = makeHarness()
    const b = board([card('1', 'todo'), card('2', 'todo')])
    const result = await h.registry.run<KanbanBoard | null>(
      'kanban.moveCard',
      { board: b, cardId: '1', columnId: 'doing' },
      HUMAN
    )
    expect(result?.cards.find((c) => c.id === '1')?.columnId).toBe('doing')
  })

  it('fires a GitHub status move for a card linked to GitHub, without blocking the result', async () => {
    const h = makeHarness()
    const linked = card('1', 'todo', { github: { itemId: 'x', url: 'https://x' } })
    const b = board([linked])
    const result = await h.registry.run<KanbanBoard | null>(
      'kanban.moveCard',
      { board: b, cardId: '1', columnId: 'doing' },
      HUMAN
    )
    expect(result).not.toBeNull()
    await Promise.resolve()
    expect(h.api.kanbanGitHubMove).toHaveBeenCalledWith('/root', expect.anything(), '1', 'doing')
  })
})

describe('kanban.ensureRepo', () => {
  it('is a no-op (no confirm) when already a repo', async () => {
    const h = makeHarness()
    const result = await h.registry.run<boolean>('kanban.ensureRepo', {}, HUMAN)
    expect(result).toBe(true)
    expect(h.confirmCalls.length).toBe(1) // registry.run's own danger gate always confirms first
    expect(h.api.gitInit).not.toHaveBeenCalled()
  })

  it('initializes a repo when confirmed and none exists', async () => {
    const h = makeHarness()
    h.api.gitStatus.mockResolvedValue({ isRepo: false })
    const result = await h.registry.run<boolean>('kanban.ensureRepo', {}, HUMAN)
    expect(result).toBe(true)
    expect(h.api.gitInit).toHaveBeenCalledWith('/root')
    expect(h.api.gitStageAll).toHaveBeenCalledWith('/root')
    expect(h.api.gitCommit).toHaveBeenCalledWith('/root', 'Initial commit', '')
  })

  it('is denied outright for an agent origin', async () => {
    const h = makeHarness()
    await expect(h.registry.run('kanban.ensureRepo', {}, AGENT)).rejects.toMatchObject({
      code: 'forbidden-origin'
    })
  })
})

describe('kanban.runCard', () => {
  it('creates a worktree, advances the card, starts the agent, then advances again', async () => {
    const h = makeHarness()
    const b = board([card('1', 'todo')])
    h.api.kanbanRead.mockResolvedValue(b)
    await h.registry.run('kanban.load', { root: '/root' }, HUMAN)

    await h.registry.run('kanban.runCard', { cardId: '1', sourceColumnId: 'todo' }, HUMAN)

    expect(h.api.kanbanWorktreeCreate).toHaveBeenCalledWith('/root', '1', 'Card 1')
    expect(h.startedAgents).toEqual([{ cardId: '1', directory: '/wt/1' }])
    // starts in 'doing' (nextColumnId from 'todo'), settles in 'done'.
    const writes = (h.api.kanbanWrite.mock.calls as [string, KanbanBoard][]).map(
      ([, b]) => b.cards.find((c) => c.id === '1')?.columnId
    )
    expect(writes).toEqual(['doing', 'done'])
  })

  it('is never agent-reachable and always requires confirmation', async () => {
    const h = makeHarness({ confirmResult: false })
    h.api.kanbanRead.mockResolvedValue(board([card('1', 'todo')]))
    await h.registry.run('kanban.load', { root: '/root' }, HUMAN)

    await expect(
      h.registry.run('kanban.runCard', { cardId: '1', sourceColumnId: 'todo' }, HUMAN)
    ).rejects.toMatchObject({ code: 'denied' })
    expect(h.startedAgents).toEqual([])

    await expect(
      h.registry.run('kanban.runCard', { cardId: '1', sourceColumnId: 'todo' }, AGENT)
    ).rejects.toMatchObject({ code: 'forbidden-origin' })
  })

  it('names the card in the confirmation summary', async () => {
    const h = makeHarness()
    h.api.kanbanRead.mockResolvedValue(board([card('1', 'todo', { title: 'Fix login bug' })]))
    await h.registry.run('kanban.load', { root: '/root' }, HUMAN)
    await h.registry.run('kanban.runCard', { cardId: '1', sourceColumnId: 'todo' }, HUMAN)
    expect(h.confirmCalls.some((s) => s.includes('Fix login bug'))).toBe(true)
  })
})

describe('kanban.runColumn', () => {
  it('launches every runnable card and advances unblocked dependents as they finish', async () => {
    const h = makeHarness()
    const b = board([
      card('1', 'todo'),
      card('2', 'todo', { dependsOn: ['1'] }) // blocked until '1' reaches done
    ])
    h.api.kanbanRead.mockResolvedValue(b)
    await h.registry.run('kanban.load', { root: '/root' }, HUMAN)

    await h.registry.run('kanban.runColumn', { columnId: 'todo' }, HUMAN)

    expect(h.startedAgents.map((a) => a.cardId).sort()).toEqual(['1', '2'])
  })

  it('skips cards with a circular dependency and toasts about them', async () => {
    const h = makeHarness()
    const cyclic = board([
      card('1', 'todo', { dependsOn: ['2'] }),
      card('2', 'todo', { dependsOn: ['1'] })
    ])
    h.api.kanbanRead.mockResolvedValue(cyclic)
    await h.registry.run('kanban.load', { root: '/root' }, HUMAN)

    await h.registry.run('kanban.runColumn', { columnId: 'todo' }, HUMAN)

    expect(h.startedAgents).toEqual([])
    expect(h.toasts.some((t) => t.includes('circular dependency'))).toBe(true)
  })

  it('is never agent-reachable', async () => {
    const h = makeHarness()
    await expect(
      h.registry.run('kanban.runColumn', { columnId: 'todo' }, AGENT)
    ).rejects.toMatchObject({
      code: 'forbidden-origin'
    })
  })
})

describe('CommandRegistryError sanity', () => {
  it('kanban.moveCard requires board/cardId/columnId', async () => {
    const h = makeHarness()
    await expect(
      h.registry.run('kanban.moveCard', { board: board([]) }, HUMAN)
    ).rejects.toBeInstanceOf(CommandRegistryError)
  })
})
