import { describe, expect, it } from 'vitest'
import { kanbanAdd, validateKanbanAdd, type KanbanFs } from './kanban-add'
import { createDefaultKanbanBoard, normalizeKanbanBoard } from '../../shared/kanban'

function memoryFs(initial: string | null = null): KanbanFs & { current(): string | null } {
  let stored = initial
  return {
    async readBoard() {
      return stored
    },
    async writeBoard(json) {
      stored = json
    },
    current() {
      return stored
    }
  }
}

describe('validateKanbanAdd', () => {
  it('requires a non-empty title', () => {
    expect(validateKanbanAdd({ title: '' })).toMatch(/title is required/)
    expect(validateKanbanAdd({ title: '   ' })).toMatch(/title is required/)
    expect(validateKanbanAdd({ title: 'Do the thing' })).toBeNull()
  })

  it('rejects an unknown priority', () => {
    // @ts-expect-error testing a runtime-invalid priority
    expect(validateKanbanAdd({ title: 'x', priority: 'urgent' })).toMatch(/priority/)
  })
})

describe('kanbanAdd', () => {
  it('creates board.json with a card when none exists', async () => {
    const fs = memoryFs(null)
    const result = await kanbanAdd({ title: 'Add rate limiting' }, { fs, fallbackTitle: 'demo board' })

    expect(result.card.title).toBe('Add rate limiting')
    expect(result.card.priority).toBe('medium')

    const board = normalizeKanbanBoard(JSON.parse(fs.current() as string), 'demo board')
    expect(board.cards).toHaveLength(1)
    // Defaults into the first column (Backlog).
    expect(result.columnName).toBe(board.columns[0]!.name)
    expect(board.cards[0]!.columnId).toBe(board.columns[0]!.id)
  })

  it('appends to an existing board and resolves status by column name', async () => {
    const seed = createDefaultKanbanBoard('demo board')
    const fs = memoryFs(`${JSON.stringify(seed, null, 2)}\n`)

    await kanbanAdd({ title: 'First' }, { fs, fallbackTitle: 'demo board' })
    const result = await kanbanAdd(
      {
        title: 'Second',
        description: '  needs review  ',
        status: 'In progress',
        priority: 'high',
        labels: [' frontend ', '', 'bug']
      },
      { fs, fallbackTitle: 'demo board' }
    )

    const board = normalizeKanbanBoard(JSON.parse(fs.current() as string), 'demo board')
    expect(board.cards).toHaveLength(2)

    const second = board.cards.find((c) => c.title === 'Second')!
    expect(second.columnId).toBe('in-progress')
    expect(result.columnName).toBe('In progress')
    expect(second.priority).toBe('high')
    expect(second.description).toBe('needs review')
    expect(second.labels).toEqual(['frontend', 'bug'])
  })

  it('falls back to the first column for an unknown status', async () => {
    const fs = memoryFs(null)
    const result = await kanbanAdd(
      { title: 'Stray', status: 'nonexistent' },
      { fs, fallbackTitle: 'demo board' }
    )
    const board = normalizeKanbanBoard(JSON.parse(fs.current() as string), 'demo board')
    expect(result.columnName).toBe(board.columns[0]!.name)
  })

  it('throws on an invalid title rather than writing', async () => {
    const fs = memoryFs(null)
    await expect(kanbanAdd({ title: '   ' }, { fs, fallbackTitle: 'demo board' })).rejects.toThrow(
      /title is required/
    )
    expect(fs.current()).toBeNull()
  })
})
