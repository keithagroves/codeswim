// Pure scheduling logic for Kanban "Run all" — figuring out which cards in
// a column are eligible to start right now, given each card's `dependsOn`.
// The actual orchestration (creating worktrees, moving cards, talking to the
// agent) lives in KanbanView; this file stays framework/IPC-free so it's
// cheap to test.

import type { KanbanBoard, KanbanCard } from '@codeswim/contract'

// A card counts as "done" once it reaches the board's last column — matches
// the default board's "Done" column, and generalizes to any custom board
// since columns are meant to read left-to-right as a pipeline.
export function doneColumnId(board: KanbanBoard): string | null {
  return board.columns.length > 0 ? board.columns[board.columns.length - 1].id : null
}

// The column a card advances to when it starts (or finishes) running,
// clamped to the last column so a short board never overflows.
export function nextColumnId(board: KanbanBoard, columnId: string): string {
  const index = board.columns.findIndex((c) => c.id === columnId)
  if (index < 0) return columnId
  return board.columns[Math.min(index + 1, board.columns.length - 1)].id
}

// Cards in `columnId` whose dependencies are all satisfied — a dependency
// counts as satisfied if it isn't on the board at all (dangling/removed) or
// if it has already reached the done column. Order is preserved from
// board.cards.
export function runnableCards(board: KanbanBoard, columnId: string): KanbanCard[] {
  const done = doneColumnId(board)
  const byId = new Map(board.cards.map((c) => [c.id, c]))
  return board.cards.filter((card) => {
    if (card.columnId !== columnId) return false
    const deps = card.dependsOn ?? []
    return deps.every((depId) => {
      const dep = byId.get(depId)
      return !dep || dep.columnId === done
    })
  })
}

// Cards in `columnId` whose dependsOn graph loops back on itself (directly
// or transitively) — those can never be satisfied since neither side can
// reach the done column before the other. Surfaced so the UI can warn
// instead of just sitting there looking blocked forever.
export function cyclicCards(board: KanbanBoard, columnId: string): KanbanCard[] {
  const byId = new Map(board.cards.map((c) => [c.id, c]))

  const isCyclic = (card: KanbanCard, path: Set<string>): boolean => {
    if (path.has(card.id)) return true
    const deps = card.dependsOn ?? []
    if (deps.length === 0) return false
    const next = new Set(path).add(card.id)
    return deps.some((depId) => {
      const dep = byId.get(depId)
      return dep !== undefined && isCyclic(dep, next)
    })
  }

  return board.cards.filter((card) => card.columnId === columnId && isCyclic(card, new Set()))
}
