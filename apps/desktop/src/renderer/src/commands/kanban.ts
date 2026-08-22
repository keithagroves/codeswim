import type { KanbanBoard, KanbanCard } from '@codeswim/contract'
import { cyclicCards, nextColumnId, runnableCards } from '../kanban-run-all'
import type { CommandCtx } from './context'
import type { CommandRegistry } from './registry'

function requireRoot(ctx: CommandCtx): string | null {
  return ctx.executionRoot
}

// A card counts as "running" from the moment kanban.runCard accepts it until
// its worktree agent settles, whether launched directly or as part of
// kanban.runColumn's dependency-ordered batch. Shared across both entry
// points (module-scoped, one instance per registry/provider lifetime) so a
// card can't be double-launched by clicking "Start in background" while
// "Run all" is already running it — mirrors the pre-command runningCardIdsRef.
export class KanbanRunTracker {
  private ids: ReadonlySet<string> = new Set()
  private readonly listeners = new Set<() => void>()

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSnapshot = (): ReadonlySet<string> => this.ids

  has(cardId: string): boolean {
    return this.ids.has(cardId)
  }

  private set(cardId: string, running: boolean): void {
    const next = new Set(this.ids)
    if (running) next.add(cardId)
    else next.delete(cardId)
    this.ids = next
    this.listeners.forEach((fn) => fn())
  }

  // run() rather than a bare set()/clear() pair so a card can never get
  // stuck "running" forever if the body throws.
  async run<T>(cardId: string, body: () => Promise<T>): Promise<T> {
    this.set(cardId, true)
    try {
      return await body()
    } finally {
      this.set(cardId, false)
    }
  }
}

export interface KanbanLoadArgs {
  root: string
}

async function runLoad(
  args: KanbanLoadArgs,
  ctx: CommandCtx,
  cache: BoardCache
): Promise<KanbanBoard | null> {
  try {
    const board = await ctx.api.kanbanRead(args.root)
    cache.current = board
    return board
  } catch (err) {
    ctx.toast(`Could not load board: ${errorMessage(err)}`, 'error')
    return null
  }
}

export interface KanbanSaveArgs {
  board: KanbanBoard
}

async function runSave(
  args: KanbanSaveArgs,
  ctx: CommandCtx,
  cache: BoardCache
): Promise<KanbanBoard | null> {
  const root = requireRoot(ctx)
  if (!root) return null
  try {
    const saved = await ctx.api.kanbanWrite(root, args.board)
    cache.current = saved
    return saved
  } catch (err) {
    ctx.toast(`Could not save board: ${errorMessage(err)}`, 'error')
    // Fall back to whatever's actually on disk rather than leaving the
    // caller's optimistic (now possibly wrong) board as the last word.
    return runLoad({ root }, ctx, cache)
  }
}

export interface KanbanGitHubSyncArgs {
  board: KanbanBoard
}

async function runGitHubSync(
  args: KanbanGitHubSyncArgs,
  ctx: CommandCtx,
  cache: BoardCache
): Promise<KanbanBoard | null> {
  const root = requireRoot(ctx)
  if (!root || !args.board.github) return null
  try {
    const synced = await ctx.api.kanbanGitHubSync(root, args.board)
    cache.current = synced
    ctx.toast(`Synced ${synced.cards.filter((card) => card.github).length} GitHub items.`)
    return synced
  } catch (err) {
    ctx.toast(`GitHub sync failed: ${errorMessage(err)}`, 'error')
    return null
  }
}

export interface KanbanMoveCardArgs {
  board: KanbanBoard
  cardId: string
  columnId: string
  beforeCardId?: string
}

async function runMoveCard(
  args: KanbanMoveCardArgs,
  ctx: CommandCtx,
  cache: BoardCache
): Promise<KanbanBoard | null> {
  const root = requireRoot(ctx)
  if (!root) return null
  const { board, cardId, columnId, beforeCardId } = args
  const current = board.cards.find((card) => card.id === cardId)
  if (!current) return null
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
  const saved = await runSave({ board: { ...board, cards } }, ctx, cache)
  if (saved && current.github) {
    void ctx.api.kanbanGitHubMove(root, saved, cardId, columnId).catch((err: unknown) => {
      ctx.toast(`GitHub status update failed: ${errorMessage(err)}`, 'error')
    })
  }
  return saved
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Serializes board.json writes so concurrent card moves (several "Run all"
// cards starting/finishing around the same time) can't clobber each other —
// mirrors the pre-command writeQueueRef/boardRef pair, just module-scoped
// instead of a component ref.
interface BoardCache {
  current: KanbanBoard | null
}

interface WriteQueue {
  current: Promise<void>
}

function queuedMoveCard(
  args: KanbanMoveCardArgs,
  ctx: CommandCtx,
  cache: BoardCache,
  queue: WriteQueue
): Promise<void> {
  const task = queue.current.then(async () => {
    const latest = cache.current
    if (!latest || !latest.cards.some((c) => c.id === args.cardId)) return
    await runMoveCard({ ...args, board: latest }, ctx, cache)
  })
  queue.current = task
  return task
}

interface EnsureRepoState {
  pending: Promise<boolean> | null
}

// Run all needs a real git repo with a first commit (`git worktree add ...
// HEAD` has nothing to check out otherwise). ensureRepoState dedupes
// concurrent callers (several cards starting at once) behind one prompt.
async function ensureGitRepo(ctx: CommandCtx, state: EnsureRepoState): Promise<boolean> {
  const root = requireRoot(ctx)
  if (!root) return false
  if (state.pending) return state.pending
  const task = (async (): Promise<boolean> => {
    try {
      const status = await ctx.api.gitStatus(root)
      if (status.isRepo) return true
      const ok = await ctx.confirm(
        { kind: 'destructive' },
        'Running agents in the background uses isolated git branches, which this folder ' +
          "doesn't have yet.\n\nInitialize a git repository here (with a first commit of " +
          'everything currently in the folder)?'
      )
      if (!ok) return false
      await ctx.api.gitInit(root)
      await ctx.api.gitStageAll(root)
      await ctx.api.gitCommit(root, 'Initial commit', '')
      return true
    } catch (err) {
      ctx.toast(`Could not initialize a git repository: ${errorMessage(err)}`, 'error')
      return false
    } finally {
      state.pending = null
    }
  })()
  state.pending = task
  return task
}

export interface KanbanRunCardArgs {
  cardId: string
  sourceColumnId: string
}

// Runs a single card: isolate it in a fresh git worktree + branch, advance it
// to the next column so it reads as "in progress", hand it to the agent, then
// advance it once more once the agent's first reply lands. The branch is left
// for manual review — Run all never merges anything. Shared by kanban.runCard
// and kanban.runColumn's per-card launches (the latter calls this directly,
// not through registry.run, so a batch launch only prompts once for the
// column-level danger confirm, not once per card).
async function doRunCard(
  args: KanbanRunCardArgs,
  ctx: CommandCtx,
  cache: BoardCache,
  queue: WriteQueue,
  ensureRepoState: EnsureRepoState,
  tracker: KanbanRunTracker
): Promise<void> {
  const root = requireRoot(ctx)
  if (!root) return
  const board = cache.current
  const card = board?.cards.find((c) => c.id === args.cardId)
  if (!board || !card) return
  await tracker.run(card.id, async () => {
    const ready = await ensureGitRepo(ctx, ensureRepoState)
    if (!ready) return
    try {
      const worktree = await ctx.api.kanbanWorktreeCreate(root, card.id, card.title)
      const runningColumn = nextColumnId(cache.current ?? board, args.sourceColumnId)
      await queuedMoveCard({ board, cardId: card.id, columnId: runningColumn }, ctx, cache, queue)
      await ctx.startAgentInWorktree(card, worktree.path)
      const settledColumn = nextColumnId(cache.current ?? board, runningColumn)
      await queuedMoveCard(
        { board: cache.current ?? board, cardId: card.id, columnId: settledColumn },
        ctx,
        cache,
        queue
      )
    } catch (err) {
      ctx.toast(`"${card.title}" failed to start: ${errorMessage(err)}`, 'error')
    }
  })
}

export interface KanbanRunColumnArgs {
  columnId: string
}

// "Run all": launches every currently-runnable card in a column, then — as
// each one finishes — rechecks the column for cards that just became
// unblocked (their dependsOn all reached the done column) and launches those
// too, until nothing runnable is left. Independent cards run concurrently,
// each in its own worktree.
async function doRunColumn(
  args: KanbanRunColumnArgs,
  ctx: CommandCtx,
  cache: BoardCache,
  queue: WriteQueue,
  ensureRepoState: EnsureRepoState,
  tracker: KanbanRunTracker
): Promise<void> {
  const board = cache.current
  if (!board) return
  const stuck = cyclicCards(board, args.columnId)
  if (stuck.length > 0) {
    ctx.toast(
      `${stuck.length} card(s) have a circular dependency and were skipped: ${stuck
        .map((c) => c.title)
        .join(', ')}`,
      'error'
    )
  }
  const stuckIds = new Set(stuck.map((c) => c.id))
  const launched = new Set<string>()

  const launch = async (card: KanbanCard): Promise<void> => {
    if (launched.has(card.id) || stuckIds.has(card.id)) return
    if (tracker.has(card.id)) return
    launched.add(card.id)
    await doRunCard(
      { cardId: card.id, sourceColumnId: args.columnId },
      ctx,
      cache,
      queue,
      ensureRepoState,
      tracker
    )
    const current = cache.current
    if (!current) return
    const unblocked = runnableCards(current, args.columnId).filter(
      (c) => !launched.has(c.id) && !tracker.has(c.id)
    )
    await Promise.all(unblocked.map((c) => launch(c)))
  }
  const initial = runnableCards(board, args.columnId).filter((c) => !tracker.has(c.id))
  await Promise.all(initial.map((c) => launch(c)))
}

// Registers the kanban command slice on `registry`. `tracker` is returned to
// the caller (state.tsx) so KanbanView can subscribe to it for "is this card
// running" UI state via useSyncExternalStore, the same pattern surface
// context uses.
export function registerKanbanCommands(registry: CommandRegistry): KanbanRunTracker {
  const cache: BoardCache = { current: null }
  const queue: WriteQueue = { current: Promise.resolve() }
  const ensureRepoState: EnsureRepoState = { pending: null }
  const tracker = new KanbanRunTracker()

  registry.register<KanbanLoadArgs, KanbanBoard | null>({
    id: 'kanban.load',
    domain: 'kanban',
    title: 'Load board',
    description: 'Reads the kanban board for a workspace root.',
    schema: { type: 'object', required: ['root'], properties: { root: { type: 'string' } } },
    agent: 'listed',
    run: (args, ctx) => runLoad(args, ctx, cache)
  })

  registry.register<KanbanSaveArgs, KanbanBoard | null>({
    id: 'kanban.save',
    domain: 'kanban',
    title: 'Save board',
    description: 'Writes the kanban board (card create/edit/delete, GitHub link/unlink).',
    schema: { type: 'object', required: ['board'], properties: { board: { type: 'object' } } },
    agent: 'never',
    run: (args, ctx) => runSave(args, ctx, cache)
  })

  registry.register<KanbanGitHubSyncArgs, KanbanBoard | null>({
    id: 'kanban.githubSync',
    domain: 'kanban',
    title: 'Sync GitHub project',
    description: "Pulls the board's linked GitHub Project items into local cards.",
    schema: { type: 'object', required: ['board'], properties: { board: { type: 'object' } } },
    agent: 'never',
    run: (args, ctx) => runGitHubSync(args, ctx, cache)
  })

  registry.register<KanbanMoveCardArgs, KanbanBoard | null>({
    id: 'kanban.moveCard',
    domain: 'kanban',
    title: 'Move card',
    description:
      'Moves a card to a column (drag-and-drop reorder), syncing GitHub status if linked.',
    schema: {
      type: 'object',
      required: ['board', 'cardId', 'columnId'],
      properties: {
        board: { type: 'object' },
        cardId: { type: 'string' },
        columnId: { type: 'string' },
        beforeCardId: { type: 'string', nullable: true }
      }
    },
    agent: 'never',
    run: (args, ctx) => runMoveCard(args, ctx, cache)
  })

  registry.register<Record<string, never>, boolean>({
    id: 'kanban.ensureRepo',
    domain: 'kanban',
    title: 'Ensure git repo',
    description:
      'Initializes a git repository (with a first commit) if the workspace root has none yet.',
    schema: { type: 'object' },
    agent: 'never',
    danger: {
      kind: 'destructive',
      summarize: () =>
        'Initialize a git repository here (with a first commit of everything currently in the folder).'
    },
    run: async (_args, ctx) => ensureGitRepo(ctx, ensureRepoState)
  })

  registry.register<KanbanRunCardArgs, void>({
    id: 'kanban.runCard',
    domain: 'kanban',
    title: 'Start card in background',
    description: 'Starts an agent on a card in an isolated git worktree, without switching views.',
    schema: {
      type: 'object',
      required: ['cardId', 'sourceColumnId'],
      properties: { cardId: { type: 'string' }, sourceColumnId: { type: 'string' } }
    },
    agent: 'never',
    danger: {
      kind: 'destructive',
      summarize: (args) => {
        const card = cache.current?.cards.find((c) => c.id === args.cardId)
        return `Start an agent on "${card?.title ?? args.cardId}" in an isolated git worktree.`
      }
    },
    run: (args, ctx) => doRunCard(args, ctx, cache, queue, ensureRepoState, tracker)
  })

  registry.register<KanbanRunColumnArgs, void>({
    id: 'kanban.runColumn',
    domain: 'kanban',
    title: 'Run all',
    description:
      'Starts every runnable card in a column, launching newly-unblocked cards as dependencies clear.',
    schema: {
      type: 'object',
      required: ['columnId'],
      properties: { columnId: { type: 'string' } }
    },
    agent: 'never',
    danger: {
      kind: 'destructive',
      summarize: (args) => {
        const board = cache.current
        const column = board?.columns.find((c) => c.id === args.columnId)
        const runnable = board ? runnableCards(board, args.columnId).length : 0
        return `Run ${runnable} card(s) in "${column?.name ?? args.columnId}" in the background, in dependency order.`
      }
    },
    run: (args, ctx) => doRunColumn(args, ctx, cache, queue, ensureRepoState, tracker)
  })

  return tracker
}
