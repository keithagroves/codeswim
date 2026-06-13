import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mergeGitHubSnapshot, readKanbanBoard, writeKanbanBoard } from './kanban'
import { createDefaultKanbanBoard, normalizeKanbanBoard } from '../shared/kanban'

describe('kanban persistence', () => {
  const dirs: string[] = []

  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  const tempWorkspace = async (): Promise<string> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codeswim-kanban-'))
    dirs.push(dir)
    return dir
  }

  it('returns a useful default for a workspace without a board file', async () => {
    const root = await tempWorkspace()
    const board = await readKanbanBoard(root)

    expect(board.title).toBe(`${path.basename(root)} board`)
    expect(board.columns.map((column) => column.name)).toEqual([
      'Backlog',
      'Ready',
      'In progress',
      'Review',
      'Done'
    ])
    expect(board.cards).toEqual([])
  })

  it('writes and reads a normalized board atomically', async () => {
    const root = await tempWorkspace()
    const saved = await writeKanbanBoard(root, {
      version: 1,
      title: 'Delivery',
      columns: [{ id: 'now', name: 'Now', color: '#123456' }],
      cards: [
        {
          id: 'one',
          title: 'Ship it',
          description: '',
          columnId: 'missing',
          priority: 'urgent',
          labels: ['release'],
          createdAt: 10,
          updatedAt: 20
        }
      ]
    })

    expect(saved.cards[0].columnId).toBe('now')
    expect(saved.cards[0].priority).toBe('medium')
    expect(await readKanbanBoard(root)).toEqual(saved)
    await expect(fs.access(path.join(root, '.codeswim', 'board.json.tmp'))).rejects.toThrow()
  })

  it('surfaces malformed board JSON', async () => {
    const root = await tempWorkspace()
    await fs.mkdir(path.join(root, '.codeswim'))
    await fs.writeFile(path.join(root, '.codeswim', 'board.json'), '{nope', 'utf-8')

    await expect(readKanbanBoard(root)).rejects.toThrow('Invalid JSON')
  })
})

describe('normalizeKanbanBoard', () => {
  it('drops duplicate identifiers and invalid GitHub configuration', () => {
    const board = normalizeKanbanBoard({
      title: 'Board',
      columns: [
        { id: 'todo', name: 'Todo', color: '#fff' },
        { id: 'todo', name: 'Duplicate', color: '#000' }
      ],
      cards: [
        { id: 'a', title: 'First', columnId: 'todo' },
        { id: 'a', title: 'Duplicate', columnId: 'todo' }
      ],
      github: { owner: '', projectNumber: 0 }
    })

    expect(board.columns).toHaveLength(1)
    expect(board.cards).toHaveLength(1)
    expect(board.github).toBeUndefined()
  })
})

describe('mergeGitHubSnapshot', () => {
  it('maps Status options to columns and preserves local cards', () => {
    const board = createDefaultKanbanBoard('Local board')
    board.github = { owner: 'acme', projectNumber: 7 }
    board.cards.push({
      id: 'local',
      title: 'Local note',
      description: '',
      columnId: 'backlog',
      priority: 'low',
      labels: [],
      createdAt: 1,
      updatedAt: 1
    })

    const merged = mergeGitHubSnapshot(
      board,
      { id: 'project-id', title: 'Roadmap', url: 'https://github.com/orgs/acme/projects/7' },
      {
        fields: [
          {
            id: 'status-field',
            name: 'Status',
            type: 'ProjectV2SingleSelectField',
            options: [
              { id: 'todo-option', name: 'Todo' },
              { id: 'doing-option', name: 'In progress' }
            ]
          }
        ]
      },
      {
        items: [
          {
            id: 'item-id',
            title: 'GitHub issue',
            body: 'From the project',
            status: 'In progress',
            labels: ['feature'],
            content: {
              type: 'Issue',
              number: 42,
              repository: 'acme/repo',
              url: 'https://github.com/acme/repo/issues/42'
            }
          }
        ]
      },
      123
    )

    expect(merged.title).toBe('Roadmap')
    expect(merged.cards.find((card) => card.id === 'local')).toBeDefined()
    const githubCard = merged.cards.find((card) => card.github?.itemId === 'item-id')
    expect(githubCard).toMatchObject({
      title: 'GitHub issue',
      columnId: 'in-progress',
      labels: ['feature'],
      github: {
        number: 42,
        repository: 'acme/repo',
        url: 'https://github.com/acme/repo/issues/42'
      }
    })
    expect(merged.github).toMatchObject({
      projectId: 'project-id',
      statusFieldId: 'status-field',
      lastSyncedAt: 123
    })
  })

  it('does not collide with an existing local column id', () => {
    const board = createDefaultKanbanBoard()
    board.github = { owner: '@me', projectNumber: 1 }
    board.columns = [{ id: 'todo', name: 'Ideas', color: '#fff' }]

    const merged = mergeGitHubSnapshot(
      board,
      {},
      {
        fields: [
          {
            id: 'status',
            name: 'Status',
            options: [{ id: 'todo-option', name: 'Todo' }]
          }
        ]
      },
      { items: [] },
      123
    )

    expect(merged.columns.map((column) => column.id)).toEqual(['todo-2', 'todo'])
  })
})
