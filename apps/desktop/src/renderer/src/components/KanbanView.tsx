import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KanbanBoard, KanbanCard, KanbanPriority } from '@codeswim/contract'
import { relativeToRoot, toPosix } from '../path-utils'
import { useStore, type TreeNode } from '../store'
import { cyclicCards, nextColumnId, runnableCards } from '../kanban-run-all'

interface CardDraft {
  id?: string
  title: string
  description: string
  columnId: string
  priority: KanbanPriority
  labels: string
  linkedPath: string
  dependsOn: string[]
}

interface GitHubDraft {
  owner: string
  projectNumber: string
}

function newCardDraft(columnId: string): CardDraft {
  return {
    title: '',
    description: '',
    columnId,
    priority: 'medium',
    labels: '',
    linkedPath: '',
    dependsOn: []
  }
}

function cardDraft(card: KanbanCard): CardDraft {
  return {
    id: card.id,
    title: card.title,
    description: card.description,
    columnId: card.columnId,
    priority: card.priority,
    labels: card.labels.join(', '),
    linkedPath: card.linkedPath ?? '',
    dependsOn: card.dependsOn ?? []
  }
}

function makeCardId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function fileOptions(nodes: TreeNode[] | null): string[] {
  const out: string[] = []
  const visit = (items: TreeNode[]): void => {
    for (const item of items) {
      if (item.kind === 'file') out.push(item.path)
      else if (item.children) visit(item.children)
    }
  }
  if (nodes) visit(nodes)
  return out
}

function shortPath(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}

function formatSyncTime(value?: number): string {
  if (!value) return 'Not synced'
  return `Synced ${new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(value)}`
}

function priorityLabel(priority: KanbanPriority): string {
  if (priority === 'high') return 'High priority'
  if (priority === 'low') return 'Low priority'
  return 'Medium priority'
}

interface CardEditorProps {
  board: KanbanBoard
  draft: CardDraft
  files: string[]
  onChange(draft: CardDraft): void
  onClose(): void
  onSave(): void
  onDelete(): void
}

function CardEditor({
  board,
  draft,
  files,
  onChange,
  onClose,
  onSave,
  onDelete
}: CardEditorProps): React.JSX.Element {
  return (
    <div className="kanban-modal-backdrop" onMouseDown={onClose}>
      <form
        className="kanban-modal"
        onSubmit={(event) => {
          event.preventDefault()
          onSave()
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="kanban-modal-header">
          <h2>{draft.id ? 'Edit item' : 'New item'}</h2>
          <button className="kanban-icon-btn" type="button" onClick={onClose} title="Close">
            ×
          </button>
        </div>
        <label className="kanban-field">
          <span>Title</span>
          <input
            autoFocus
            required
            value={draft.title}
            onChange={(event) => onChange({ ...draft, title: event.target.value })}
          />
        </label>
        <label className="kanban-field">
          <span>Description</span>
          <textarea
            rows={5}
            value={draft.description}
            onChange={(event) => onChange({ ...draft, description: event.target.value })}
          />
        </label>
        <div className="kanban-field-row">
          <label className="kanban-field">
            <span>Status</span>
            <select
              value={draft.columnId}
              onChange={(event) => onChange({ ...draft, columnId: event.target.value })}
            >
              {board.columns.map((column) => (
                <option key={column.id} value={column.id}>
                  {column.name}
                </option>
              ))}
            </select>
          </label>
          <label className="kanban-field">
            <span>Priority</span>
            <select
              value={draft.priority}
              onChange={(event) =>
                onChange({ ...draft, priority: event.target.value as KanbanPriority })
              }
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
        </div>
        <label className="kanban-field">
          <span>Labels</span>
          <input
            value={draft.labels}
            placeholder="frontend, bug, next"
            onChange={(event) => onChange({ ...draft, labels: event.target.value })}
          />
        </label>
        {board.cards.length > 0 ? (
          <div className="kanban-field">
            <span>Depends on</span>
            <div className="kanban-depends-list">
              {board.cards
                .filter((candidate) => candidate.id !== draft.id)
                .map((candidate) => (
                  <label key={candidate.id} className="kanban-depends-item">
                    <input
                      type="checkbox"
                      checked={draft.dependsOn.includes(candidate.id)}
                      onChange={(event) =>
                        onChange({
                          ...draft,
                          dependsOn: event.target.checked
                            ? [...draft.dependsOn, candidate.id]
                            : draft.dependsOn.filter((id) => id !== candidate.id)
                        })
                      }
                    />
                    {candidate.title}
                  </label>
                ))}
            </div>
          </div>
        ) : null}
        <label className="kanban-field">
          <span>Linked file</span>
          <input
            list="kanban-file-options"
            value={draft.linkedPath}
            placeholder="architecture/auth.md"
            onChange={(event) => onChange({ ...draft, linkedPath: event.target.value })}
          />
          <datalist id="kanban-file-options">
            {files.map((file) => (
              <option key={file} value={file} />
            ))}
          </datalist>
        </label>
        <div className="kanban-modal-actions">
          {draft.id ? (
            <button className="kanban-danger-btn" type="button" onClick={onDelete}>
              Delete
            </button>
          ) : (
            <span />
          )}
          <div>
            <button className="secondary" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" type="submit" disabled={!draft.title.trim()}>
              Save
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}

interface GitHubEditorProps {
  draft: GitHubDraft
  connected: boolean
  onChange(draft: GitHubDraft): void
  onClose(): void
  onConnect(): void
  onDisconnect(): void
}

function GitHubEditor({
  draft,
  connected,
  onChange,
  onClose,
  onConnect,
  onDisconnect
}: GitHubEditorProps): React.JSX.Element {
  return (
    <div className="kanban-modal-backdrop" onMouseDown={onClose}>
      <form
        className="kanban-modal kanban-github-modal"
        onSubmit={(event) => {
          event.preventDefault()
          onConnect()
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="kanban-modal-header">
          <h2>GitHub Project</h2>
          <button className="kanban-icon-btn" type="button" onClick={onClose} title="Close">
            ×
          </button>
        </div>
        <label className="kanban-field">
          <span>Owner</span>
          <input
            autoFocus
            required
            value={draft.owner}
            placeholder="@me or organization"
            onChange={(event) => onChange({ ...draft, owner: event.target.value })}
          />
        </label>
        <label className="kanban-field">
          <span>Project number</span>
          <input
            required
            min="1"
            type="number"
            value={draft.projectNumber}
            onChange={(event) => onChange({ ...draft, projectNumber: event.target.value })}
          />
        </label>
        <div className="kanban-modal-actions">
          {connected ? (
            <button className="kanban-danger-btn" type="button" onClick={onDisconnect}>
              Disconnect
            </button>
          ) : (
            <span />
          )}
          <div>
            <button className="secondary" type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              className="primary"
              type="submit"
              disabled={!draft.owner.trim() || Number(draft.projectNumber) <= 0}
            >
              Connect and sync
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}

export function KanbanView(): React.JSX.Element {
  const { state, navigateAbsolute, toast, startAgentFromCard, startAgentInWorktree } = useStore()
  const rootPath = state.rootPath
  const [board, setBoard] = useState<KanbanBoard | null>(null)
  const [cardEditor, setCardEditor] = useState<CardDraft | null>(null)
  const [githubEditor, setGitHubEditor] = useState<GitHubDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [draggingCardId, setDraggingCardId] = useState<string | null>(null)
  const [dropColumnId, setDropColumnId] = useState<string | null>(null)
  const [runningCardIds, setRunningCardIds] = useState<Set<string>>(new Set())
  const [runningColumns, setRunningColumns] = useState<Set<string>>(new Set())
  const runningCardIdsRef = useRef<Set<string>>(new Set())
  const files = useMemo(() => fileOptions(state.tree), [state.tree])
  // Bumped on every local mutation (persist/sync). Writing board.json fires
  // the file watcher, whose reload races our own setBoard — a stale disk read
  // must not clobber state from a newer local mutation.
  const mutationGeneration = useRef(0)
  // Mirrors `board` synchronously (state updates land a render late) so
  // Run all's column-move writes can be serialized without racing each other.
  const boardRef = useRef<KanbanBoard | null>(null)
  useEffect(() => {
    boardRef.current = board
  }, [board])

  const loadBoard = useCallback(async () => {
    if (!rootPath) return
    const generation = mutationGeneration.current
    try {
      const next = await window.api.kanbanRead(rootPath)
      if (mutationGeneration.current === generation) setBoard(next)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast(`Could not load board: ${message}`, 'error')
    }
  }, [rootPath, toast])

  useEffect(() => {
    // setBoard fires after the IPC await, not synchronously in the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadBoard()
  }, [loadBoard])

  useEffect(() => {
    if (!rootPath) return
    return window.api.onFileChanged((absPath) => {
      const rel = relativeToRoot(toPosix(rootPath), toPosix(absPath))
      if (rel === '.codeswim/board.json') void loadBoard()
    })
  }, [loadBoard, rootPath])

  const persist = useCallback(
    async (next: KanbanBoard): Promise<KanbanBoard | null> => {
      if (!rootPath) return null
      mutationGeneration.current += 1
      setBoard(next)
      setSaving(true)
      try {
        const saved = await window.api.kanbanWrite(rootPath, next)
        setBoard(saved)
        return saved
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        toast(`Could not save board: ${message}`, 'error')
        await loadBoard()
        return null
      } finally {
        setSaving(false)
      }
    },
    [loadBoard, rootPath, toast]
  )

  const syncGitHub = useCallback(
    async (source?: KanbanBoard) => {
      if (!rootPath || !(source ?? board)?.github) return
      mutationGeneration.current += 1
      setSyncing(true)
      try {
        const synced = await window.api.kanbanGitHubSync(rootPath, source ?? (board as KanbanBoard))
        setBoard(synced)
        toast(`Synced ${synced.cards.filter((card) => card.github).length} GitHub items.`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        toast(`GitHub sync failed: ${message}`, 'error')
      } finally {
        setSyncing(false)
      }
    },
    [board, rootPath, toast]
  )

  // Run all's column moves happen concurrently (several cards can start or
  // finish around the same time) — `moveCard` below reads `board` from its
  // closure, so two calls landing before React re-renders between them would
  // silently lose one. This instead threads every write through boardRef and
  // a promise chain so writes serialize no matter how many callers fire at
  // once.
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve())
  const moveCardIsolated = useCallback(
    (cardId: string, columnId: string): Promise<void> => {
      const task = writeQueueRef.current.then(async () => {
        if (!rootPath) return
        const current = boardRef.current
        if (!current || !current.cards.some((c) => c.id === cardId)) return
        const cards = current.cards.map((c) =>
          c.id === cardId ? { ...c, columnId, updatedAt: Date.now() } : c
        )
        const next = { ...current, cards }
        boardRef.current = next
        setBoard(next)
        try {
          const saved = await window.api.kanbanWrite(rootPath, next)
          boardRef.current = saved
          setBoard(saved)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          toast(`Could not save board: ${message}`, 'error')
        }
      })
      writeQueueRef.current = task
      return task
    },
    [rootPath, toast]
  )

  const setCardRunning = useCallback((cardId: string, running: boolean) => {
    const next = new Set(runningCardIdsRef.current)
    if (running) next.add(cardId)
    else next.delete(cardId)
    runningCardIdsRef.current = next
    setRunningCardIds(next)
  }, [])

  // Runs a single card: isolate it in a fresh git worktree + branch, advance
  // it to the next column so it reads as "in progress", hand it to the agent,
  // then advance it once more once the agent's first reply lands. The branch
  // itself is left for manual review — Run all never merges anything.
  //
  // Worktrees need a real git repo with at least one commit (`git worktree
  // add ... HEAD` has nothing to check out otherwise). If the workspace isn't
  // one yet, ask before silently failing — memoized on a ref so concurrent
  // callers (several cards starting at once from Run all) share one prompt
  // instead of popping a confirm dialog per card.
  const ensureRepoPromiseRef = useRef<Promise<boolean> | null>(null)
  const ensureGitRepo = useCallback((): Promise<boolean> => {
    if (!rootPath) return Promise.resolve(false)
    if (ensureRepoPromiseRef.current) return ensureRepoPromiseRef.current
    const task = (async (): Promise<boolean> => {
      try {
        const status = await window.api.gitStatus(rootPath)
        if (status.isRepo) return true
        const ok = window.confirm(
          'Running agents in the background uses isolated git branches, which this folder ' +
            "doesn't have yet.\n\nInitialize a git repository here (with a first commit of " +
            'everything currently in the folder)?'
        )
        if (!ok) return false
        await window.api.gitInit(rootPath)
        await window.api.gitStageAll(rootPath)
        await window.api.gitCommit(rootPath, 'Initial commit', '')
        return true
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        toast(`Could not initialize a git repository: ${message}`, 'error')
        return false
      } finally {
        ensureRepoPromiseRef.current = null
      }
    })()
    ensureRepoPromiseRef.current = task
    return task
  }, [rootPath, toast])

  const runCard = useCallback(
    async (card: KanbanCard, sourceColumnId: string): Promise<void> => {
      if (!rootPath) return
      const ready = await ensureGitRepo()
      if (!ready) return
      setCardRunning(card.id, true)
      try {
        const worktree = await window.api.kanbanWorktreeCreate(rootPath, card.id, card.title)
        const runningColumn = nextColumnId(boardRef.current ?? board!, sourceColumnId)
        await moveCardIsolated(card.id, runningColumn)
        await startAgentInWorktree(card, worktree.path)
        const settledColumn = nextColumnId(boardRef.current ?? board!, runningColumn)
        await moveCardIsolated(card.id, settledColumn)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        toast(`"${card.title}" failed to start: ${message}`, 'error')
      } finally {
        setCardRunning(card.id, false)
      }
    },
    [board, ensureGitRepo, moveCardIsolated, rootPath, setCardRunning, startAgentInWorktree, toast]
  )

  // Kanban "Run all": launches every currently-runnable card in a column,
  // then — as each one finishes — rechecks the column for cards that just
  // became unblocked (their dependsOn all reached the done column) and
  // launches those too, until nothing runnable is left. Independent cards
  // run concurrently, each in its own worktree.
  const runAllInColumn = useCallback(
    async (columnId: string) => {
      if (!board || !rootPath) return
      const stuck = cyclicCards(board, columnId)
      if (stuck.length > 0) {
        toast(
          `${stuck.length} card(s) have a circular dependency and were skipped: ${stuck
            .map((c) => c.title)
            .join(', ')}`,
          'error'
        )
      }
      const stuckIds = new Set(stuck.map((c) => c.id))
      const launched = new Set<string>()

      setRunningColumns((prev) => new Set(prev).add(columnId))
      try {
        const launch = async (card: KanbanCard): Promise<void> => {
          if (launched.has(card.id) || stuckIds.has(card.id)) return
          if (runningCardIdsRef.current.has(card.id)) return
          launched.add(card.id)
          await runCard(card, columnId)
          const current = boardRef.current
          if (!current) return
          const unblocked = runnableCards(current, columnId).filter(
            (c) => !launched.has(c.id) && !runningCardIdsRef.current.has(c.id)
          )
          await Promise.all(unblocked.map((c) => launch(c)))
        }
        const initial = runnableCards(board, columnId).filter(
          (c) => !runningCardIdsRef.current.has(c.id)
        )
        await Promise.all(initial.map((c) => launch(c)))
      } finally {
        setRunningColumns((prev) => {
          const next = new Set(prev)
          next.delete(columnId)
          return next
        })
      }
    },
    [board, rootPath, runCard, toast]
  )

  const saveCard = useCallback(async () => {
    if (!board || !cardEditor) return
    const now = Date.now()
    const labels = cardEditor.labels
      .split(',')
      .map((label) => label.trim())
      .filter(Boolean)
    const existing = cardEditor.id
      ? board.cards.find((card) => card.id === cardEditor.id)
      : undefined
    const card: KanbanCard = {
      id: existing?.id ?? makeCardId(),
      title: cardEditor.title.trim(),
      description: cardEditor.description.trim(),
      columnId: cardEditor.columnId,
      priority: cardEditor.priority,
      labels,
      linkedPath: cardEditor.linkedPath.trim() || undefined,
      github: existing?.github,
      dependsOn: cardEditor.dependsOn.length > 0 ? cardEditor.dependsOn : undefined,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    const cards = existing
      ? board.cards.map((candidate) => (candidate.id === card.id ? card : candidate))
      : [...board.cards, card]
    await persist({ ...board, cards })
    setCardEditor(null)
  }, [board, cardEditor, persist])

  const deleteCard = useCallback(async () => {
    if (!board || !cardEditor?.id) return
    await persist({ ...board, cards: board.cards.filter((card) => card.id !== cardEditor.id) })
    setCardEditor(null)
  }, [board, cardEditor, persist])

  const moveCard = useCallback(
    async (cardId: string, columnId: string, beforeCardId?: string) => {
      if (!board) return
      const current = board.cards.find((card) => card.id === cardId)
      if (!current) return
      const moved: KanbanCard = { ...current, columnId, updatedAt: Date.now() }
      const cards = board.cards.filter((card) => card.id !== cardId)
      let insertAt = beforeCardId ? cards.findIndex((card) => card.id === beforeCardId) : -1
      if (insertAt < 0) {
        const lastInColumn = cards.reduce(
          (last, card, index) => (card.columnId === columnId ? index : last),
          -1
        )
        insertAt = lastInColumn + 1
      }
      cards.splice(insertAt, 0, moved)
      const next = { ...board, cards }
      const saved = await persist(next)
      if (saved && current.github && rootPath) {
        void window.api
          .kanbanGitHubMove(rootPath, saved, cardId, columnId)
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err)
            toast(`GitHub status update failed: ${message}`, 'error')
          })
      }
      setDraggingCardId(null)
      setDropColumnId(null)
    },
    [board, persist, rootPath, toast]
  )

  const connectGitHub = useCallback(async () => {
    if (!board || !githubEditor) return
    const projectNumber = Number.parseInt(githubEditor.projectNumber, 10)
    if (!githubEditor.owner.trim() || !Number.isFinite(projectNumber) || projectNumber <= 0) return
    const next: KanbanBoard = {
      ...board,
      github: { owner: githubEditor.owner.trim(), projectNumber }
    }
    const saved = await persist(next)
    setGitHubEditor(null)
    if (saved) await syncGitHub(saved)
  }, [board, githubEditor, persist, syncGitHub])

  const disconnectGitHub = useCallback(async () => {
    if (!board) return
    const cards = board.cards.map((card) => ({ ...card, github: undefined }))
    await persist({ ...board, cards, github: undefined })
    setGitHubEditor(null)
  }, [board, persist])

  const cardsByColumn = useMemo(() => {
    const map = new Map<string, KanbanCard[]>()
    for (const card of board?.cards ?? []) {
      const list = map.get(card.columnId)
      if (list) list.push(card)
      else map.set(card.columnId, [card])
    }
    return map
  }, [board])

  if (!board) {
    return <div className="kanban-loading">Loading board…</div>
  }

  return (
    <div className="kanban-view">
      <div className="kanban-toolbar">
        <div className="kanban-title-block">
          <div className="kanban-title-row">
            <h1>{board.title}</h1>
            {saving ? <span className="kanban-save-state">Saving…</span> : null}
          </div>
          <div className="kanban-subtitle">
            <span>{board.cards.length} items</span>
            {board.github ? (
              <>
                <span className="kanban-subtitle-separator">·</span>
                <span>
                  {board.github.owner} #{board.github.projectNumber}
                </span>
                <span className="kanban-subtitle-separator">·</span>
                <span>{formatSyncTime(board.github.lastSyncedAt)}</span>
              </>
            ) : null}
          </div>
        </div>
        <div className="kanban-toolbar-actions">
          {board.github?.projectUrl ? (
            <button
              className="kanban-icon-btn"
              onClick={() => window.open(board.github?.projectUrl, '_blank')}
              title="Open GitHub Project"
              aria-label="Open GitHub Project"
            >
              ↗
            </button>
          ) : null}
          <button
            className="secondary"
            onClick={() =>
              setGitHubEditor({
                owner: board.github?.owner ?? '@me',
                projectNumber: board.github ? String(board.github.projectNumber) : ''
              })
            }
          >
            GitHub
          </button>
          {board.github ? (
            <button className="secondary" disabled={syncing} onClick={() => void syncGitHub()}>
              {syncing ? 'Syncing…' : 'Sync'}
            </button>
          ) : null}
          <button
            className="primary"
            onClick={() => setCardEditor(newCardDraft(board.columns[0].id))}
          >
            + Add item
          </button>
        </div>
      </div>

      <div className="kanban-board" aria-label="Project board">
        {board.columns.map((column) => {
          const cards = cardsByColumn.get(column.id) ?? []
          const isDropTarget = dropColumnId === column.id
          const runnable = runnableCards(board, column.id).filter((c) => !runningCardIds.has(c.id))
          const isRunning = runningColumns.has(column.id)
          return (
            <section
              key={column.id}
              className={`kanban-column ${isDropTarget ? 'is-drop-target' : ''}`}
              onDragOver={(event) => {
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                setDropColumnId(column.id)
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setDropColumnId((current) => (current === column.id ? null : current))
                }
              }}
              onDrop={(event) => {
                event.preventDefault()
                const cardId = event.dataTransfer.getData('text/plain') || draggingCardId
                if (cardId) void moveCard(cardId, column.id)
              }}
            >
              <div className="kanban-column-header">
                <div className="kanban-column-name">
                  <span className="kanban-column-dot" style={{ background: column.color }} />
                  <h2>{column.name}</h2>
                  <span className="kanban-column-count">{cards.length}</span>
                </div>
                <div className="kanban-column-actions">
                  {runnable.length > 0 || isRunning ? (
                    <button
                      className="kanban-run-all-btn"
                      disabled={isRunning || runnable.length === 0}
                      onClick={() => void runAllInColumn(column.id)}
                      title={
                        isRunning
                          ? 'Running…'
                          : `Run ${runnable.length} card(s) in the background, in dependency order`
                      }
                    >
                      {isRunning ? 'Running…' : `▶ Run all (${runnable.length})`}
                    </button>
                  ) : null}
                  <button
                    className="kanban-icon-btn"
                    onClick={() => setCardEditor(newCardDraft(column.id))}
                    title={`Add item to ${column.name}`}
                    aria-label={`Add item to ${column.name}`}
                  >
                    +
                  </button>
                </div>
              </div>
              <div className="kanban-card-list">
                {cards.map((card) => (
                  <article
                    key={card.id}
                    className={`kanban-card ${draggingCardId === card.id ? 'is-dragging' : ''}`}
                    draggable
                    tabIndex={0}
                    onClick={() => setCardEditor(cardDraft(card))}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        setCardEditor(cardDraft(card))
                      }
                    }}
                    onDragStart={(event) => {
                      setDraggingCardId(card.id)
                      event.dataTransfer.effectAllowed = 'move'
                      event.dataTransfer.setData('text/plain', card.id)
                    }}
                    onDragEnd={() => {
                      setDraggingCardId(null)
                      setDropColumnId(null)
                    }}
                    onDragOver={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                    }}
                    onDrop={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      const cardId = event.dataTransfer.getData('text/plain') || draggingCardId
                      if (cardId && cardId !== card.id) {
                        void moveCard(cardId, column.id, card.id)
                      }
                    }}
                  >
                    <div className="kanban-card-topline">
                      <span
                        className={`kanban-priority kanban-priority-${card.priority}`}
                        title={priorityLabel(card.priority)}
                      />
                      {card.github ? <span className="kanban-card-source">GitHub</span> : null}
                      {card.dependsOn && card.dependsOn.length > 0 ? (
                        <span
                          className="kanban-card-depends"
                          title={`Depends on: ${card.dependsOn
                            .map((id) => board.cards.find((c) => c.id === id)?.title ?? '(deleted)')
                            .join(', ')}`}
                        >
                          ⛓ {card.dependsOn.length}
                        </span>
                      ) : null}
                    </div>
                    <h3>{card.title}</h3>
                    {card.description ? <p>{card.description}</p> : null}
                    {card.labels.length > 0 ? (
                      <div className="kanban-labels">
                        {card.labels.slice(0, 4).map((label) => (
                          <span key={label} className="kanban-label">
                            {label}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {card.linkedPath || card.github?.url ? (
                      <div className="kanban-card-links">
                        {card.linkedPath ? (
                          <button
                            onClick={(event) => {
                              event.stopPropagation()
                              void navigateAbsolute(card.linkedPath as string, true)
                            }}
                            title={card.linkedPath}
                          >
                            {shortPath(card.linkedPath)}
                          </button>
                        ) : null}
                        {card.github?.url ? (
                          <button
                            className="kanban-external-link"
                            onClick={(event) => {
                              event.stopPropagation()
                              window.open(card.github?.url, '_blank')
                            }}
                            title="Open on GitHub"
                            aria-label="Open on GitHub"
                          >
                            ↗
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="kanban-card-actions">
                      <button
                        className="kanban-start-btn"
                        disabled={runningCardIds.has(card.id)}
                        onClick={(event) => {
                          event.stopPropagation()
                          startAgentFromCard(card)
                        }}
                        title="Start an agent on this task and switch to it"
                      >
                        ▶ Start
                      </button>
                      <button
                        className="kanban-start-btn kanban-start-btn-bg"
                        disabled={runningCardIds.has(card.id)}
                        onClick={(event) => {
                          event.stopPropagation()
                          void runCard(card, column.id)
                        }}
                        title="Start an agent on this task in an isolated git worktree, without switching views"
                      >
                        {runningCardIds.has(card.id) ? '● Running…' : '▶ Start in background'}
                      </button>
                    </div>
                  </article>
                ))}
                {cards.length === 0 ? (
                  <button
                    className="kanban-empty-column"
                    onClick={() => setCardEditor(newCardDraft(column.id))}
                  >
                    + Add item
                  </button>
                ) : null}
              </div>
            </section>
          )
        })}
      </div>

      {cardEditor ? (
        <CardEditor
          board={board}
          draft={cardEditor}
          files={files}
          onChange={setCardEditor}
          onClose={() => setCardEditor(null)}
          onSave={() => void saveCard()}
          onDelete={() => void deleteCard()}
        />
      ) : null}
      {githubEditor ? (
        <GitHubEditor
          draft={githubEditor}
          connected={Boolean(board.github)}
          onChange={setGitHubEditor}
          onClose={() => setGitHubEditor(null)}
          onConnect={() => void connectGitHub()}
          onDisconnect={() => void disconnectGitHub()}
        />
      ) : null}
    </div>
  )
}
