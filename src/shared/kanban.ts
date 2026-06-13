export type KanbanPriority = 'low' | 'medium' | 'high'

export interface KanbanColumn {
  id: string
  name: string
  color: string
}

export interface KanbanGitHubItem {
  itemId: string
  url?: string
  type?: string
  number?: number
  repository?: string
}

export interface KanbanCard {
  id: string
  title: string
  description: string
  columnId: string
  priority: KanbanPriority
  labels: string[]
  linkedPath?: string
  github?: KanbanGitHubItem
  createdAt: number
  updatedAt: number
}

export interface KanbanGitHubStatusOption {
  name: string
  id: string
}

export interface KanbanGitHubConfig {
  owner: string
  projectNumber: number
  projectId?: string
  statusFieldId?: string
  statusOptions?: KanbanGitHubStatusOption[]
  projectUrl?: string
  lastSyncedAt?: number
}

export interface KanbanBoard {
  version: 1
  title: string
  columns: KanbanColumn[]
  cards: KanbanCard[]
  github?: KanbanGitHubConfig
}

const DEFAULT_COLUMNS: KanbanColumn[] = [
  { id: 'backlog', name: 'Backlog', color: '#8b8b96' },
  { id: 'ready', name: 'Ready', color: '#5b9cf5' },
  { id: 'in-progress', name: 'In progress', color: '#d9a73e' },
  { id: 'review', name: 'Review', color: '#b47aea' },
  { id: 'done', name: 'Done', color: '#3ecf8e' }
]

export function createDefaultKanbanBoard(title = 'Project board'): KanbanBoard {
  return {
    version: 1,
    title,
    columns: DEFAULT_COLUMNS.map((column) => ({ ...column })),
    cards: []
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

export function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

export function numberValue(value: unknown): number | undefined
export function numberValue(value: unknown, fallback: number): number
export function numberValue(value: unknown, fallback?: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function normalizeGitHubConfig(value: unknown): KanbanGitHubConfig | undefined {
  if (!isRecord(value)) return undefined
  const owner = stringValue(value.owner).trim()
  const projectNumber = numberValue(value.projectNumber, 0)
  if (!owner || projectNumber <= 0) return undefined

  const statusOptions = Array.isArray(value.statusOptions)
    ? value.statusOptions
        .filter(isRecord)
        .map((option) => ({
          name: stringValue(option.name).trim(),
          id: stringValue(option.id).trim()
        }))
        .filter((option) => option.name && option.id)
    : undefined

  return {
    owner,
    projectNumber,
    projectId: stringValue(value.projectId).trim() || undefined,
    statusFieldId: stringValue(value.statusFieldId).trim() || undefined,
    statusOptions: statusOptions && statusOptions.length > 0 ? statusOptions : undefined,
    projectUrl: stringValue(value.projectUrl).trim() || undefined,
    lastSyncedAt:
      typeof value.lastSyncedAt === 'number' && Number.isFinite(value.lastSyncedAt)
        ? value.lastSyncedAt
        : undefined
  }
}

export function normalizeKanbanBoard(value: unknown, fallbackTitle = 'Project board'): KanbanBoard {
  if (!isRecord(value)) return createDefaultKanbanBoard(fallbackTitle)

  const seenColumns = new Set<string>()
  const columns = Array.isArray(value.columns)
    ? value.columns
        .filter(isRecord)
        .map((column) => ({
          id: stringValue(column.id).trim(),
          name: stringValue(column.name).trim(),
          color: stringValue(column.color, '#8b8b96').trim() || '#8b8b96'
        }))
        .filter((column) => {
          if (!column.id || !column.name || seenColumns.has(column.id)) return false
          seenColumns.add(column.id)
          return true
        })
    : []

  const normalizedColumns =
    columns.length > 0 ? columns : createDefaultKanbanBoard(fallbackTitle).columns
  const validColumns = new Set(normalizedColumns.map((column) => column.id))
  const fallbackColumn = normalizedColumns[0].id
  const seenCards = new Set<string>()
  const now = Date.now()

  const cards = Array.isArray(value.cards)
    ? value.cards
        .filter(isRecord)
        .map((card): KanbanCard | null => {
          const id = stringValue(card.id).trim()
          const title = stringValue(card.title).trim()
          if (!id || !title || seenCards.has(id)) return null
          seenCards.add(id)

          const github = isRecord(card.github)
            ? {
                itemId: stringValue(card.github.itemId).trim(),
                url: stringValue(card.github.url).trim() || undefined,
                type: stringValue(card.github.type).trim() || undefined,
                number:
                  typeof card.github.number === 'number' && Number.isFinite(card.github.number)
                    ? card.github.number
                    : undefined,
                repository: stringValue(card.github.repository).trim() || undefined
              }
            : undefined

          const priority = card.priority
          return {
            id,
            title,
            description: stringValue(card.description),
            columnId: validColumns.has(stringValue(card.columnId))
              ? stringValue(card.columnId)
              : fallbackColumn,
            priority:
              priority === 'low' || priority === 'high' || priority === 'medium'
                ? priority
                : 'medium',
            labels: Array.isArray(card.labels)
              ? card.labels.filter((label): label is string => typeof label === 'string')
              : [],
            linkedPath: stringValue(card.linkedPath).trim() || undefined,
            github: github?.itemId ? github : undefined,
            createdAt: numberValue(card.createdAt, now),
            updatedAt: numberValue(card.updatedAt, now)
          }
        })
        .filter((card): card is KanbanCard => card !== null)
    : []

  return {
    version: 1,
    title: stringValue(value.title).trim() || fallbackTitle,
    columns: normalizedColumns,
    cards,
    github: normalizeGitHubConfig(value.github)
  }
}
