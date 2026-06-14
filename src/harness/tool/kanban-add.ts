import {
  createDefaultKanbanBoard,
  makeCardId,
  normalizeKanbanBoard,
  type KanbanBoard,
  type KanbanCard,
  type KanbanPriority
} from '../../shared/kanban'

export interface KanbanAddParams {
  title: string
  description?: string
  // Column to drop the card in — matched against a column id or name
  // (case-insensitive). Defaults to the first column when omitted/unmatched.
  status?: string
  priority?: KanbanPriority
  labels?: string[]
  // POSIX path relative to workspace root of a diagram/source file this card
  // is about, so the card can deep-link into the navigator.
  linkedPath?: string
}

export interface KanbanAddResult {
  card: KanbanCard
  columnName: string
  boardTitle: string
}

// The board lives at `.codeswim/board.json`. The fs adapter keeps the pure
// logic testable and lets the plugin own the actual file path resolution.
export interface KanbanFs {
  // Raw board.json contents, or null when the file doesn't exist yet.
  readBoard(): Promise<string | null>
  writeBoard(json: string): Promise<void>
}

const PRIORITIES: ReadonlySet<string> = new Set(['low', 'medium', 'high'])

export function validateKanbanAdd(params: KanbanAddParams): string | null {
  if (typeof params.title !== 'string' || !params.title.trim()) {
    return 'title is required'
  }
  if (params.priority !== undefined && !PRIORITIES.has(params.priority)) {
    return 'priority must be one of: low, medium, high'
  }
  return null
}

function resolveColumnId(board: KanbanBoard, status?: string): string {
  const fallback = board.columns[0]!.id
  if (!status || !status.trim()) return fallback
  const wanted = status.trim().toLowerCase()
  const match = board.columns.find(
    (column) => column.id.toLowerCase() === wanted || column.name.toLowerCase() === wanted
  )
  return match ? match.id : fallback
}

export async function kanbanAdd(
  params: KanbanAddParams,
  ctx: { fs: KanbanFs; fallbackTitle: string }
): Promise<KanbanAddResult> {
  const err = validateKanbanAdd(params)
  if (err) throw new Error(`kanban_add: ${err}`)

  const raw = await ctx.fs.readBoard()
  const board = raw
    ? normalizeKanbanBoard(JSON.parse(raw), ctx.fallbackTitle)
    : createDefaultKanbanBoard(ctx.fallbackTitle)

  const columnId = resolveColumnId(board, params.status)
  const now = Date.now()
  const card: KanbanCard = {
    id: makeCardId(),
    title: params.title.trim(),
    description: (params.description ?? '').trim(),
    columnId,
    priority: params.priority ?? 'medium',
    labels: Array.isArray(params.labels)
      ? params.labels.map((label) => label.trim()).filter(Boolean)
      : [],
    linkedPath: params.linkedPath?.trim() || undefined,
    createdAt: now,
    updatedAt: now
  }

  const next: KanbanBoard = { ...board, cards: [...board.cards, card] }
  // Normalize once more so what we persist matches what the app would write.
  const normalized = normalizeKanbanBoard(next, ctx.fallbackTitle)
  await ctx.fs.writeBoard(`${JSON.stringify(normalized, null, 2)}\n`)

  const column = normalized.columns.find((c) => c.id === columnId) ?? normalized.columns[0]!
  return { card, columnName: column.name, boardTitle: normalized.title }
}
