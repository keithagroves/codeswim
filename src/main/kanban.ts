import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  createDefaultKanbanBoard,
  normalizeKanbanBoard,
  numberValue,
  recordValue,
  stringValue,
  type KanbanBoard,
  type KanbanCard,
  type KanbanColumn,
  type KanbanGitHubStatusOption
} from '../shared/kanban'

const execFileAsync = promisify(execFile)
const BOARD_RELATIVE_PATH = path.join('.codeswim', 'board.json')
const MAX_BUFFER = 64 * 1024 * 1024
const COLUMN_COLORS = ['#5b9cf5', '#d9a73e', '#b47aea', '#3ecf8e', '#ef7d7d', '#64c4c7']

interface GitHubProjectJson {
  id?: unknown
  title?: unknown
  url?: unknown
}

interface GitHubFieldJson {
  id?: unknown
  name?: unknown
  type?: unknown
  options?: unknown
}

interface GitHubItemJson {
  id?: unknown
  title?: unknown
  body?: unknown
  status?: unknown
  url?: unknown
  type?: unknown
  number?: unknown
  repository?: unknown
  labels?: unknown
  content?: unknown
}

function boardPath(rootPath: string): string {
  return path.join(rootPath, BOARD_RELATIVE_PATH)
}

export async function readKanbanBoard(rootPath: string): Promise<KanbanBoard> {
  const fallbackTitle = `${path.basename(rootPath)} board`
  try {
    const raw = await fs.readFile(boardPath(rootPath), 'utf-8')
    return normalizeKanbanBoard(JSON.parse(raw), fallbackTitle)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return createDefaultKanbanBoard(fallbackTitle)
    if (err instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${BOARD_RELATIVE_PATH}`)
    }
    throw err
  }
}

export async function writeKanbanBoard(rootPath: string, value: unknown): Promise<KanbanBoard> {
  const board = normalizeKanbanBoard(value, `${path.basename(rootPath)} board`)
  const file = boardPath(rootPath)
  const temp = `${file}.tmp`
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(temp, `${JSON.stringify(board, null, 2)}\n`, 'utf-8')
  await fs.rename(temp, file)
  return board
}

async function runGh(rootPath: string, args: string[]): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync('gh', args, {
      cwd: rootPath,
      encoding: 'utf-8',
      maxBuffer: MAX_BUFFER
    })
    return JSON.parse(stdout)
  } catch (err) {
    const error = err as { code?: string; stderr?: string; message?: string }
    if (error.code === 'ENOENT') {
      throw new Error('GitHub CLI was not found. Install `gh`, then sign in with `gh auth login`.')
    }
    const detail = (error.stderr || error.message || '').trim()
    throw new Error(detail || 'GitHub CLI command failed')
  }
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'column'
  )
}

function uniqueColumnId(name: string, used: Set<string>): string {
  const base = slug(name)
  let candidate = base
  let suffix = 2
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }
  used.add(candidate)
  return candidate
}

function githubStatusOptions(fields: GitHubFieldJson[]): {
  fieldId?: string
  options: KanbanGitHubStatusOption[]
} {
  const field = fields.find((candidate) => stringValue(candidate.name).toLowerCase() === 'status')
  if (!field) return { options: [] }
  const options = Array.isArray(field.options)
    ? field.options
        .map(recordValue)
        .map((option) => ({ name: stringValue(option.name), id: stringValue(option.id) }))
        .filter((option) => option.name && option.id)
    : []
  return { fieldId: stringValue(field.id) || undefined, options }
}

function columnsForStatuses(
  current: KanbanColumn[],
  statuses: KanbanGitHubStatusOption[]
): KanbanColumn[] {
  if (statuses.length === 0) return current
  const used = new Set(current.map((column) => column.id))
  const matched = new Set<string>()
  const statusColumns = statuses.map((status, index) => {
    const existing = current.find(
      (column) => column.name.toLowerCase() === status.name.toLowerCase()
    )
    if (existing) {
      used.add(existing.id)
      matched.add(existing.id)
      return existing
    }
    return {
      id: uniqueColumnId(status.name, used),
      name: status.name,
      color: COLUMN_COLORS[index % COLUMN_COLORS.length]
    }
  })
  return [...statusColumns, ...current.filter((column) => !matched.has(column.id))]
}

function itemContent(item: GitHubItemJson): Record<string, unknown> {
  return recordValue(item.content)
}

function githubLabels(item: GitHubItemJson): string[] {
  const raw = Array.isArray(item.labels) ? item.labels : []
  return raw
    .map((label) => (typeof label === 'string' ? label : stringValue(recordValue(label).name)))
    .filter(Boolean)
}

function mergeGitHubItems(
  board: KanbanBoard,
  rawItems: GitHubItemJson[],
  columns: KanbanColumn[]
): KanbanCard[] {
  const now = Date.now()
  const existingByItem = new Map(
    board.cards
      .filter((card) => card.github?.itemId)
      .map((card) => [card.github?.itemId as string, card])
  )
  const localCards = board.cards.filter((card) => !card.github?.itemId)

  const imported = rawItems.flatMap((item): KanbanCard[] => {
    const itemId = stringValue(item.id)
    const content = itemContent(item)
    const title = stringValue(item.title) || stringValue(content.title)
    if (!itemId || !title) return []

    const status = stringValue(item.status)
    const column =
      columns.find((candidate) => candidate.name.toLowerCase() === status.toLowerCase()) ??
      columns[0]
    const existing = existingByItem.get(itemId)
    const url = stringValue(item.url) || stringValue(content.url)
    const type = stringValue(item.type) || stringValue(content.type)
    const repository = stringValue(item.repository) || stringValue(content.repository)
    const number = numberValue(item.number) ?? numberValue(content.number)

    return [
      {
        id: existing?.id ?? `github-${itemId}`,
        title,
        description: stringValue(item.body) || stringValue(content.body),
        columnId: column.id,
        priority: existing?.priority ?? 'medium',
        labels: githubLabels(item),
        linkedPath: existing?.linkedPath,
        github: {
          itemId,
          url: url || undefined,
          type: type || undefined,
          number,
          repository: repository || undefined
        },
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      }
    ]
  })

  return [...localCards, ...imported]
}

export function mergeGitHubSnapshot(
  board: KanbanBoard,
  projectRaw: unknown,
  fieldsRaw: unknown,
  itemsRaw: unknown,
  syncedAt = Date.now()
): KanbanBoard {
  const project = projectRaw as GitHubProjectJson
  const fieldsRecord = recordValue(fieldsRaw)
  const itemsRecord = recordValue(itemsRaw)
  const fields = Array.isArray(fieldsRecord.fields)
    ? (fieldsRecord.fields as GitHubFieldJson[])
    : []
  const items = Array.isArray(itemsRecord.items) ? (itemsRecord.items as GitHubItemJson[]) : []
  const status = githubStatusOptions(fields)
  const columns = columnsForStatuses(board.columns, status.options)

  return {
    ...board,
    title: stringValue(project.title) || board.title,
    columns,
    cards: mergeGitHubItems(board, items, columns),
    github: board.github
      ? {
          ...board.github,
          projectId: stringValue(project.id) || board.github.projectId,
          // A sync that can't find the Status field must not clobber a
          // previously valid id — moveGitHubKanbanItem depends on it.
          statusFieldId: status.fieldId ?? board.github.statusFieldId,
          statusOptions: status.options.length > 0 ? status.options : board.github.statusOptions,
          projectUrl: stringValue(project.url) || board.github.projectUrl,
          lastSyncedAt: syncedAt
        }
      : undefined
  }
}

export async function syncKanbanWithGitHub(rootPath: string, value: unknown): Promise<KanbanBoard> {
  const board = normalizeKanbanBoard(value, `${path.basename(rootPath)} board`)
  const config = board.github
  if (!config) throw new Error('Connect a GitHub Project before syncing.')

  const base = [String(config.projectNumber), '--owner', config.owner, '--format', 'json']
  const [projectRaw, fieldsRaw, itemsRaw] = await Promise.all([
    runGh(rootPath, ['project', 'view', ...base]),
    runGh(rootPath, ['project', 'field-list', ...base, '--limit', '100']),
    runGh(rootPath, ['project', 'item-list', ...base, '--limit', '1000'])
  ])

  const next = mergeGitHubSnapshot(board, projectRaw, fieldsRaw, itemsRaw)
  return writeKanbanBoard(rootPath, next)
}

export async function moveGitHubKanbanItem(
  rootPath: string,
  value: unknown,
  cardId: string,
  columnId: string
): Promise<void> {
  const board = normalizeKanbanBoard(value, `${path.basename(rootPath)} board`)
  const config = board.github
  const card = board.cards.find((candidate) => candidate.id === cardId)
  const column = board.columns.find((candidate) => candidate.id === columnId)
  if (!config || !card?.github?.itemId || !column) return
  if (!config.projectId || !config.statusFieldId || !config.statusOptions) {
    throw new Error('Sync the board with GitHub before pushing status changes.')
  }

  const option = config.statusOptions.find(
    (candidate) => candidate.name.toLowerCase() === column.name.toLowerCase()
  )
  if (!option) return

  await runGh(rootPath, [
    'project',
    'item-edit',
    '--id',
    card.github.itemId,
    '--project-id',
    config.projectId,
    '--field-id',
    config.statusFieldId,
    '--single-select-option-id',
    option.id,
    '--format',
    'json'
  ])
}
