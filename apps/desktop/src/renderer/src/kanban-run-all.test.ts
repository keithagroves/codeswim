import { describe, expect, it } from 'vitest'
import type { KanbanBoard, KanbanCard } from '@codeswim/contract'
import { cyclicCards, doneColumnId, nextColumnId, runnableCards } from './kanban-run-all'

function card(overrides: Partial<KanbanCard> & Pick<KanbanCard, 'id' | 'columnId'>): KanbanCard {
  return {
    title: overrides.id,
    description: '',
    priority: 'medium',
    labels: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

function board(cards: KanbanCard[]): KanbanBoard {
  return {
    version: 1,
    title: 'Board',
    columns: [
      { id: 'backlog', name: 'Backlog', color: '#000' },
      { id: 'ready', name: 'Ready', color: '#000' },
      { id: 'in-progress', name: 'In progress', color: '#000' },
      { id: 'done', name: 'Done', color: '#000' }
    ],
    cards
  }
}

describe('doneColumnId / nextColumnId', () => {
  it('done is the last column', () => {
    expect(doneColumnId(board([]))).toBe('done')
  })

  it('next advances one column', () => {
    const b = board([])
    expect(nextColumnId(b, 'ready')).toBe('in-progress')
  })

  it('next clamps at the last column', () => {
    const b = board([])
    expect(nextColumnId(b, 'done')).toBe('done')
  })

  it('an unknown column id is returned unchanged', () => {
    const b = board([])
    expect(nextColumnId(b, 'nope')).toBe('nope')
  })
})

describe('runnableCards', () => {
  it('includes cards in the column with no dependencies', () => {
    const b = board([card({ id: 'a', columnId: 'ready' })])
    expect(runnableCards(b, 'ready').map((c) => c.id)).toEqual(['a'])
  })

  it('excludes cards outside the column', () => {
    const b = board([card({ id: 'a', columnId: 'backlog' })])
    expect(runnableCards(b, 'ready')).toEqual([])
  })

  it('excludes a card whose dependency has not reached done', () => {
    const b = board([
      card({ id: 'a', columnId: 'ready' }),
      card({ id: 'b', columnId: 'ready', dependsOn: ['a'] })
    ])
    expect(runnableCards(b, 'ready').map((c) => c.id)).toEqual(['a'])
  })

  it('includes a card once its dependency has reached done', () => {
    const b = board([
      card({ id: 'a', columnId: 'done' }),
      card({ id: 'b', columnId: 'ready', dependsOn: ['a'] })
    ])
    expect(runnableCards(b, 'ready').map((c) => c.id)).toEqual(['b'])
  })

  it('treats a dangling dependency (removed card) as satisfied', () => {
    const b = board([card({ id: 'b', columnId: 'ready', dependsOn: ['gone'] })])
    expect(runnableCards(b, 'ready').map((c) => c.id)).toEqual(['b'])
  })

  it('requires every dependency to be satisfied', () => {
    const b = board([
      card({ id: 'a', columnId: 'done' }),
      card({ id: 'b', columnId: 'ready' }),
      card({ id: 'c', columnId: 'ready', dependsOn: ['a', 'b'] })
    ])
    // 'a' is already done and not itself in 'ready'; 'b' has no deps so it's
    // runnable; 'c' is blocked because 'b' hasn't reached done yet.
    expect(runnableCards(b, 'ready').map((c) => c.id)).toEqual(['b'])
  })
})

describe('cyclicCards', () => {
  it('is empty for an acyclic graph', () => {
    const b = board([
      card({ id: 'a', columnId: 'ready' }),
      card({ id: 'b', columnId: 'ready', dependsOn: ['a'] })
    ])
    expect(cyclicCards(b, 'ready')).toEqual([])
  })

  it('flags a direct two-card cycle', () => {
    const b = board([
      card({ id: 'a', columnId: 'ready', dependsOn: ['b'] }),
      card({ id: 'b', columnId: 'ready', dependsOn: ['a'] })
    ])
    expect(cyclicCards(b, 'ready').map((c) => c.id).sort()).toEqual(['a', 'b'])
  })

  it('flags a self-dependency', () => {
    const b = board([card({ id: 'a', columnId: 'ready', dependsOn: ['a'] })])
    expect(cyclicCards(b, 'ready').map((c) => c.id)).toEqual(['a'])
  })

  it('flags a longer transitive cycle', () => {
    const b = board([
      card({ id: 'a', columnId: 'ready', dependsOn: ['c'] }),
      card({ id: 'b', columnId: 'ready', dependsOn: ['a'] }),
      card({ id: 'c', columnId: 'ready', dependsOn: ['b'] })
    ])
    expect(cyclicCards(b, 'ready').map((c) => c.id).sort()).toEqual(['a', 'b', 'c'])
  })
})
