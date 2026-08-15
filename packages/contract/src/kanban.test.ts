import { describe, expect, it } from 'vitest'
import { normalizeKanbanBoard } from './kanban'

function boardWithCard(card: Record<string, unknown>): unknown {
  return {
    version: 1,
    title: 'Board',
    columns: [{ id: 'ready', name: 'Ready', color: '#fff' }],
    cards: [{ id: 'a', title: 'Card A', columnId: 'ready', ...card }]
  }
}

describe('normalizeKanbanBoard dependsOn', () => {
  it('keeps a valid list of dependency ids', () => {
    const board = normalizeKanbanBoard(boardWithCard({ dependsOn: ['b', 'c'] }))
    expect(board.cards[0].dependsOn).toEqual(['b', 'c'])
  })

  it('drops non-string entries, self-references, and duplicates', () => {
    const board = normalizeKanbanBoard(boardWithCard({ dependsOn: ['b', 'a', 'b', 42, '', null] }))
    expect(board.cards[0].dependsOn).toEqual(['b'])
  })

  it('omits the field entirely when there are no dependencies', () => {
    const board = normalizeKanbanBoard(boardWithCard({ dependsOn: [] }))
    expect(board.cards[0].dependsOn).toBeUndefined()
  })

  it('defaults to no dependencies when the field is missing or malformed', () => {
    const board = normalizeKanbanBoard(boardWithCard({}))
    expect(board.cards[0].dependsOn).toBeUndefined()
    const board2 = normalizeKanbanBoard(boardWithCard({ dependsOn: 'not-an-array' }))
    expect(board2.cards[0].dependsOn).toBeUndefined()
  })
})
