// The whiteboard's controller: the conversation, the board model, and the
// build hand-off, outside React.
//
// It lives as long as the StoreProvider (one per window) so a conversation
// and a running build survive switching views. The tldraw canvas attaches
// while the Whiteboard view is mounted and is rebuilt from the board model
// when it remounts; drawing commands always update the model, and only
// animate when a canvas is attached.
//
// Flow (plans/talking-whiteboard.md, Design):
//   ask → Turn (opener + parts, spoken while drawn) → maybe a guarded build
//   line → deps.build (the workspace's agent session, diagram-first, out of
//   sight) → checkpoint → a walkthrough Turn on a new page, now if the view
//   is showing, otherwise when it's next opened.

import {
  asksToClear,
  BoardModel,
  canShow,
  diffPages,
  formatCheckpoint,
  formatPage,
  guardCmd,
  isPageCmd,
  Turn,
  type Action,
  type BoardState,
  type Checkpoint,
  type Effect,
  type Msg,
  type NarratorTransport,
  type Page,
  type PageCmd,
  type PageContext,
  type PageSnapshot,
  type ShotImage,
  type Speaker,
  type TurnRequest,
  type TurnResult,
  type TurnTiming
} from '@codeswim/whiteboard'
import { formatResearch, type ResearchOutcome } from './research'

/** The canvas: animates effects, and redraws everything from the model. */
export interface WhiteboardCanvas {
  render(effects: Effect[]): Promise<void>
  rebuild(board: BoardModel): void
}

export interface BuildOutcome {
  checkpoint: Checkpoint
  /** Unified diff of what the build changed, for "Open the diff". */
  diff: string
}

/** The browser panel beside the board (browser/panel.ts), as the whiteboard uses it. */
export interface WhiteboardBrowser {
  /** The page showing in the panel, outlined; null when none is. */
  snapshot(): Promise<PageSnapshot | null>
  /** The page showing right now, or null. */
  currentUrl(): string | null
  /** With no page open: where the app is running, or which dev servers could start. */
  context(): PageContext
  point(target: string, all: boolean): Promise<void>
  show(url: string): Promise<void>
  /** Reload the page and wait for it to settle. */
  reload(): Promise<void>
  /** Start a dev-server run; resolves with its local address once printed, or null if none came. */
  startServer(name: string): Promise<string | null>
  /** Save a screenshot of the page for the board, with where its elements sit; null without a page. */
  capture?(): Promise<ShotImage | null>
}

export interface WhiteboardDeps {
  /** A narrator transport (connects to, or starts, the narrator's opencode server). */
  connect(): Promise<NarratorTransport & { warm?(): void; dispose?(): void }>
  speaker: Speaker
  /** The <project> block: the workspace's real diagrams. Cached by the caller. */
  project(): Promise<string>
  /**
   * Send the brief to the workspace's agent session and wait for the
   * checkpoint. `conversation` is what was said on the whiteboard, in words.
   */
  build(brief: string, pagesInWords: string, conversation: string): Promise<BuildOutcome>
  /** The <files> block for a question: workspace files it names, read (files.ts). */
  files?(question: string): Promise<string>
  /** Have a read-only agent look into a question (research.ts). */
  research?(question: string, signal: AbortSignal): Promise<ResearchOutcome>
  /** The agent chat session the conversation is showing in, to tag entries with. */
  chatSession?(): string | null
  openLink(path: string): Promise<void>
  showDiff(label: string, diff: string): void
  /** Read / write the saved board for a workspace (its root path). */
  load(workspace: string): Promise<string | null>
  save(workspace: string, json: string): Promise<void>
  /** Whether the Whiteboard view is on screen right now. */
  isVisible(): boolean
  /** The browser panel, so the narrator can talk about (and point at) the page beside the board. */
  browser?: WhiteboardBrowser
  /** A screenshot on the board, as a URL the canvas can show (null if it's gone). */
  shotImage?(file: string): Promise<string | null>
  notify(message: string, kind?: 'info' | 'error'): void
  log?(message: string, detail?: unknown): void
}

export interface TranscriptEntry {
  id: number
  who: 'you' | 'narrator' | 'info'
  text: string
  /** When it was said (ms), to place it among the agent chat's messages. */
  at?: number
  /** The agent chat session it was said in; it shows in that session's thread. */
  session?: string | null
}

export interface LastBuild {
  brief: string
  diagrams: string[]
  files: number
  diff: string
}

export interface WhiteboardSnapshot {
  entries: TranscriptEntry[]
  pages: Page[]
  currentPageId: string
  blank: boolean
  /** A turn is being spoken / drawn. */
  talking: boolean
  /** The sentence being spoken right now. */
  caption: string | null
  /** The design brief while the agent is building it. */
  building: string | null
  /** A build finished while the view was hidden; its walkthrough is waiting. */
  walkthroughReady: boolean
  lastBuild: LastBuild | null
  muted: boolean
  timing: TurnTiming | null
  connecting: boolean
  /** The question the read-only agent is looking into, if any. */
  researching: string | null
}

export type WhiteboardMode = 'idle' | 'talking' | 'building' | 'walkthrough'

interface Saved {
  version: 1
  board: BoardState
  history: Msg[]
  entries: TranscriptEntry[]
  lastBuild: LastBuild | null
  pendingCheckpoint: Checkpoint | null
}

const MAX_ENTRIES = 200
const MAX_HISTORY = 40
const MAX_SAVED_DIFF = 200_000
const WALKTHROUGH_QUESTION = 'Walk me through what you just built.'
// How many questions after a walkthrough a direct change request ("make them
// even wider") still counts as the go-ahead. Never restored from disk: a
// build from an earlier session isn't "just built".
const FOLLOW_UP_TURNS = 2

export class WhiteboardController {
  private board = new BoardModel()
  private history: Msg[] = []
  private entries: TranscriptEntry[] = []
  private entrySeq = 1
  private turn: Turn | null = null
  private turnMode: 'talk' | 'walkthrough' | null = null
  private canvas: WhiteboardCanvas | null = null
  private transport: (NarratorTransport & { warm?(): void; dispose?(): void }) | null = null
  private connecting: Promise<NarratorTransport> | null = null
  private building: string | null = null
  private researching: { question: string; ctl: AbortController } | null = null
  private pendingResearch: ResearchOutcome | null = null
  private pendingCheckpoint: Checkpoint | null = null
  private lastBuild: LastBuild | null = null
  private followUpTurns = 0
  // The person's latest question, so a page that comes up later can answer it.
  private lastQuestion: string | null = null
  private startingServer = false
  private muted = false
  private caption: string | null = null
  private timing: TurnTiming | null = null
  private listeners = new Set<() => void>()
  private snapshot: WhiteboardSnapshot
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private workspace: string | null = null
  // Bumped on every workspace switch so a stale load/build can't write into the new one.
  private generation = 0

  constructor(private readonly deps: WhiteboardDeps) {
    this.snapshot = this.compute()
  }

  // ---- external store (useSyncExternalStore)

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): WhiteboardSnapshot => this.snapshot

  get mode(): WhiteboardMode {
    if (this.turn && this.turnMode === 'walkthrough') return 'walkthrough'
    if (this.turn) return 'talking'
    if (this.building) return 'building'
    return 'idle'
  }

  /** The board model, read-only use (the canvas rebuilds from it). */
  get model(): BoardModel {
    return this.board
  }

  private compute(): WhiteboardSnapshot {
    return {
      entries: this.entries,
      pages: this.board.pages,
      currentPageId: this.board.currentPage.id,
      blank: this.board.isBlank,
      talking: this.turn !== null,
      caption: this.caption,
      building: this.building,
      walkthroughReady: this.pendingCheckpoint !== null && this.building === null,
      lastBuild: this.lastBuild,
      muted: this.muted,
      timing: this.timing,
      connecting: this.connecting !== null,
      researching: this.researching?.question ?? null
    }
  }

  private emit(): void {
    this.snapshot = this.compute()
    for (const l of this.listeners) l()
  }

  // ---- canvas

  /** A screenshot on the board, for the canvas to show. */
  shotImage(file: string): Promise<string | null> {
    return this.deps.shotImage?.(file) ?? Promise.resolve(null)
  }

  attach(canvas: WhiteboardCanvas): void {
    this.canvas = canvas
    canvas.rebuild(this.board)
  }

  detach(canvas: WhiteboardCanvas): void {
    if (this.canvas === canvas) this.canvas = null
  }

  /** The view became visible: a walkthrough that was waiting plays now. */
  visible(): void {
    if (this.turn) return
    if (this.pendingCheckpoint && !this.building) void this.playWalkthrough()
    else if (this.pendingResearch) void this.playResearch()
  }

  // ---- workspace

  /** Load the saved board and conversation for the workspace that's now open (null: none). */
  async open(workspace: string | null): Promise<void> {
    if (workspace === this.workspace) return
    // The previous workspace keeps what was said up to now.
    await this.flush()
    const gen = ++this.generation
    this.workspace = workspace
    this.interrupt()
    // A build started in the previous workspace reports nowhere now; its
    // result is dropped by the generation check in startBuild.
    this.building = null
    this.reset(false)
    if (!workspace) return
    let raw: string | null = null
    try {
      raw = await this.deps.load(workspace)
    } catch (e) {
      this.deps.log?.('[whiteboard] could not load the saved board', e)
    }
    if (gen !== this.generation || !raw) return
    try {
      const saved = JSON.parse(raw) as Partial<Saved>
      if (saved.version !== 1) return
      this.board = BoardModel.fromJSON(saved.board)
      this.history = Array.isArray(saved.history)
        ? saved.history.filter(isMsg).slice(-MAX_HISTORY)
        : []
      this.entries = Array.isArray(saved.entries)
        ? saved.entries.filter(isEntry).slice(-MAX_ENTRIES)
        : []
      this.entrySeq = this.entries.reduce((n, e) => Math.max(n, e.id + 1), 1)
      this.lastBuild = isLastBuild(saved.lastBuild) ? saved.lastBuild : null
      this.pendingCheckpoint = saved.pendingCheckpoint ?? null
    } catch (e) {
      this.deps.log?.('[whiteboard] saved board was unreadable; starting fresh', e)
    }
    this.canvas?.rebuild(this.board)
    this.emit()
  }

  /** Start a fresh board and conversation (the person asked for it). */
  newBoard(): void {
    this.interrupt()
    this.reset(true)
  }

  private reset(save: boolean): void {
    this.board = new BoardModel()
    this.history = []
    this.entries = []
    this.lastBuild = null
    this.followUpTurns = 0
    this.pendingCheckpoint = null
    this.researching?.ctl.abort()
    this.researching = null
    this.pendingResearch = null
    this.caption = null
    this.timing = null
    this.canvas?.rebuild(this.board)
    this.emit()
    if (save) this.scheduleSave()
  }

  dispose(): void {
    void this.flush()
    this.interrupt()
    this.generation++
    this.transport?.dispose?.()
    this.transport = null
  }

  // ---- the person's side

  setMuted(muted: boolean): void {
    this.muted = muted
    this.emit()
  }

  get isMuted(): boolean {
    return this.muted
  }

  /** Stop talking and drawing now. A running build carries on. */
  interrupt(): void {
    this.turn?.interrupt()
  }

  showPage(id: string): void {
    const fx = this.board.showPage(id)
    if (!fx.length) return
    void this.canvas?.render(fx)
    this.emit()
    this.scheduleSave()
  }

  async openLink(path: string): Promise<void> {
    await this.deps.openLink(path)
  }

  showLastDiff(): void {
    if (this.lastBuild?.diff) this.deps.showDiff('Whiteboard build', this.lastBuild.diff)
  }

  /** Ask the narrator something. Interrupts whatever it was saying. */
  async ask(text: string): Promise<void> {
    const question = text.trim()
    if (!question) return
    this.interrupt()
    this.addEntry('you', question)
    this.lastQuestion = question
    // Right after a walkthrough, "make them even wider" is itself the go-ahead (guards.ts asksForChange).
    const followUp = this.followUpTurns > 0
    this.followUpTurns = Math.max(0, this.followUpTurns - 1)
    await this.runTurn({ question, history: this.history, mode: 'talk', followUp })
  }

  async playWalkthrough(): Promise<void> {
    const checkpoint = this.pendingCheckpoint
    if (!checkpoint) return
    this.pendingCheckpoint = null
    this.interrupt()
    this.emit()
    await this.runTurn({
      question: WALKTHROUGH_QUESTION,
      history: this.history,
      mode: 'walkthrough',
      checkpoint: formatCheckpoint(checkpoint)
    })
  }

  // ---- turns

  private async runTurn(req: TurnRequest): Promise<void> {
    const gen = this.generation
    let transport: NarratorTransport
    let project = ''
    let page = ''
    let files = ''
    try {
      ;[transport, project, page, files] = await Promise.all([
        this.ensureTransport(),
        this.deps.project().catch(() => ''),
        this.pageBlock(),
        req.mode === 'talk' && this.deps.files
          ? this.deps.files(req.question).catch(() => '')
          : Promise.resolve('')
      ])
    } catch (e) {
      this.addEntry('info', `Couldn't reach the narrator: ${errorText(e)}`)
      return
    }
    if (gen !== this.generation) return
    const mayClear = req.mode === 'talk' && asksToClear(req.question)
    const turn = new Turn(
      {
        transport,
        speaker: this.deps.speaker,
        run: (cmd) => this.draw(cmd, mayClear, gen, req.question),
        describe: () => this.board.describe(),
        project: () => project,
        page: () => page,
        files: () => files,
        onSaid: (said) => this.said(said),
        log: (message, detail) => this.deps.log?.(message, detail)
      },
      req
    )
    this.turn = turn
    this.turnMode = req.mode
    this.caption = null
    this.emit()
    const result = await turn.done
    if (this.turn === turn) {
      this.turn = null
      this.turnMode = null
      this.caption = null
    }
    if (gen !== this.generation) return
    this.finishTurn(req, result)
  }

  private finishTurn(req: TurnRequest, result: TurnResult): void {
    this.timing = result.timing
    this.deps.log?.('[whiteboard] turn timing (ms)', {
      mode: req.mode,
      firstSpoken: result.timing.firstSpoken,
      firstAnswerSpoken: result.timing.firstAnswerSpoken,
      firstDrawing: result.timing.firstDrawing,
      opener: result.timing.opener,
      parts: result.timing.parts,
      maxGap: result.timing.maxGap,
      total: result.timing.total
    })
    if (result.error) {
      this.addEntry('info', result.error)
      // The narrator's server may have gone away; reconnect next time.
      this.transport = null
    }
    const reply = result.reply + (result.aborted ? '\n(interrupted)' : '')
    this.history = [
      ...req.history,
      { role: 'user' as const, content: req.question },
      { role: 'assistant' as const, content: reply.trim() || '(no reply)' }
    ].slice(-MAX_HISTORY)
    if (req.mode === 'walkthrough' && !result.aborted) this.followUpTurns = FOLLOW_UP_TURNS
    this.emit()
    this.scheduleSave()
    if (result.build) void this.startBuild(result.build)
    else if (result.research) void this.startResearch(result.research)
    else if (this.pendingResearch && this.deps.isVisible()) void this.playResearch()
    else if (this.pendingCheckpoint && !this.building && this.deps.isVisible())
      void this.playWalkthrough()
  }

  private async draw(cmd: Action, mayClear: boolean, gen: number, question: string): Promise<void> {
    if (gen !== this.generation) return
    if (isPageCmd(cmd)) return this.onPage(cmd, question)
    let ok = guardCmd(cmd, { mayClear, board: this.board })
    if (!ok) return
    if (ok.op === 'shot') {
      // A picture of the page beside the board; nothing to take without one.
      const browser = this.deps.browser
      if (!browser?.capture || !browser.currentUrl()) return
      const image = await browser.capture().catch((e: unknown) => {
        this.deps.log?.('[whiteboard] screenshot failed', e)
        return null
      })
      if (!image || gen !== this.generation) return
      ok = { ...ok, image }
    }
    const fx = this.board.apply(ok)
    if (!fx.length) return
    if (ok.op === 'page' || ok.op === 'clear') this.emit()
    this.scheduleSave()
    await this.canvas?.render(fx)
  }

  /** The <page> block for a request: the page beside the board, or where the app is running. */
  private async pageBlock(): Promise<string> {
    const browser = this.deps.browser
    if (!browser) return ''
    const page = await browser.snapshot().catch(() => null)
    return formatPage(page, browser.context())
  }

  private async onPage(cmd: PageCmd, question: string): Promise<void> {
    const browser = this.deps.browser
    if (!browser) return
    if (cmd.op === 'start') {
      // Don't hold up the sentences still to come; the server takes a while.
      void this.startServer(cmd.name, question)
      return
    }
    if (cmd.op === 'point') {
      if (browser.currentUrl()) await browser.point(cmd.target, cmd.all)
      return
    }
    if (!canShow(cmd.url, browser.currentUrl())) {
      this.deps.log?.('[whiteboard] not opening a page outside the running app', cmd.url)
      return
    }
    await browser.show(cmd.url)
  }

  /**
   * Start a dev server the narrator offered to start, open it beside the
   * board, then answer the person's question again with the page in view —
   * unless they've asked something else in the meantime.
   */
  private async startServer(name: string, question: string): Promise<void> {
    const browser = this.deps.browser
    if (!browser || this.startingServer) return
    // Only a dev server the <page> block offered, and only while nothing else runs.
    if (!browser.context().servers?.includes(name)) {
      this.deps.log?.('[whiteboard] not starting a run that was not offered', name)
      return
    }
    const gen = this.generation
    this.startingServer = true
    this.addEntry('info', `Starting "${name}"…`)
    let url: string | null = null
    try {
      url = await browser.startServer(name)
    } catch (e) {
      if (gen === this.generation)
        this.addEntry('info', `Couldn't start "${name}": ${errorText(e)}`)
      return
    } finally {
      this.startingServer = false
    }
    if (gen !== this.generation) return
    if (!url) {
      this.addEntry(
        'info',
        `"${name}" didn't print a local address. Open your app with the globe button once it's up.`
      )
      return
    }
    try {
      await browser.show(url)
    } catch (e) {
      this.addEntry('info', `Couldn't open ${url}: ${errorText(e)}`)
      return
    }
    this.addEntry('info', `Opened ${url} beside the board.`)
    await this.turn?.done
    if (gen !== this.generation || this.turn || this.lastQuestion !== question) return
    await this.runTurn({
      question: `(It's open beside the board now.) ${question}`,
      history: this.history,
      mode: 'talk'
    })
  }

  private said(text: string): void {
    this.caption = text
    const last = this.entries.at(-1)
    if (last?.who === 'narrator') {
      this.entries = [...this.entries.slice(0, -1), { ...last, text: `${last.text} ${text}` }]
    } else {
      this.addEntry('narrator', text)
      return
    }
    this.emit()
  }

  private addEntry(who: TranscriptEntry['who'], text: string): void {
    const entry: TranscriptEntry = {
      id: this.entrySeq++,
      who,
      text,
      at: Date.now(),
      session: this.deps.chatSession?.() ?? null
    }
    this.entries = [...this.entries, entry].slice(-MAX_ENTRIES)
    this.emit()
  }

  /** The recent conversation as plain lines, for the builder's brief. */
  private conversationInWords(): string {
    return this.entries
      .filter((e) => e.who !== 'info')
      .slice(-16)
      .map((e) => `${e.who === 'you' ? 'Person' : 'Narrator'}: ${e.text}`)
      .join('\n')
      .slice(-4000)
  }

  // ---- research: a read-only agent looks into a question

  /** Have the read-only agent look into something the narrator couldn't answer. */
  private async startResearch(question: string): Promise<void> {
    if (!this.deps.research) return
    if (this.researching) {
      this.addEntry(
        'info',
        `Still looking into "${this.researching.question}"; ask again once that's back.`
      )
      return
    }
    const gen = this.generation
    const ctl = new AbortController()
    this.researching = { question, ctl }
    this.addEntry('info', `Looking into it: ${question}`)
    let outcome: ResearchOutcome
    try {
      outcome = await this.deps.research(question, ctl.signal)
    } catch (e) {
      outcome = { question, answer: '', files: [], error: errorText(e) }
    }
    if (gen !== this.generation) return
    this.researching = null
    if (outcome.stopped) {
      this.addEntry('info', 'Stopped looking into it.')
      return
    }
    this.pendingResearch = outcome
    this.emit()
    if (this.deps.isVisible() && !this.turn) void this.playResearch()
    else if (!this.deps.isVisible())
      this.deps.notify(
        'The agent finished looking into your question. Open the Whiteboard to hear it.'
      )
  }

  /** Stop the read-only agent's look. */
  cancelResearch(): void {
    this.researching?.ctl.abort()
  }

  /** Tell the person what the read-only agent found. */
  async playResearch(): Promise<void> {
    const found = this.pendingResearch
    if (!found) return
    this.pendingResearch = null
    await this.runTurn({
      question: `(The agent looked into "${found.question}".) Tell me what it found.`,
      history: this.history,
      mode: 'talk',
      research: formatResearch(found)
    })
  }

  private async ensureTransport(): Promise<NarratorTransport> {
    if (this.transport) return this.transport
    if (!this.connecting) {
      this.connecting = this.deps
        .connect()
        .then((t) => {
          this.transport = t
          t.warm?.()
          return t
        })
        .finally(() => {
          this.connecting = null
          this.emit()
        })
      this.emit()
    }
    return this.connecting
  }

  /** Start the narrator's server and spare sessions ahead of the first question. */
  warm(): void {
    void this.ensureTransport().catch(() => {})
  }

  // ---- build hand-off

  private async startBuild(brief: string): Promise<void> {
    if (this.building) {
      this.addEntry('info', 'A build is already running; this one will wait until you ask again.')
      return
    }
    const gen = this.generation
    this.building = brief
    this.addEntry('info', 'Building: the agent updates the diagrams first, then the code.')
    this.scheduleSave()
    // The page beside the board, before: compared with after for the walkthrough.
    const before = await this.deps.browser?.snapshot().catch(() => null)
    let outcome: BuildOutcome
    try {
      outcome = await this.deps.build(brief, this.board.describePages(), this.conversationInWords())
    } catch (e) {
      outcome = {
        checkpoint: { brief, diagrams: [], files: [], finalMessage: '', error: errorText(e) },
        diff: ''
      }
    }
    if (gen !== this.generation) return
    if (before) outcome.checkpoint.page = await this.measurePage(before)
    if (gen !== this.generation) return
    this.building = null
    const { checkpoint, diff } = outcome
    this.lastBuild = {
      brief,
      diagrams: checkpoint.diagrams.map((d) => d.path),
      files: checkpoint.files.length,
      diff
    }
    this.pendingCheckpoint = checkpoint
    this.emit()
    this.scheduleSave()
    if (this.deps.isVisible() && !this.turn) {
      void this.playWalkthrough()
    } else {
      this.deps.notify(
        checkpoint.error
          ? 'The whiteboard build ended with an error. Open the Whiteboard for what happened.'
          : 'The whiteboard build finished. Open the Whiteboard for the walkthrough.',
        checkpoint.error ? 'error' : 'info'
      )
    }
  }

  /** Reload the page the build may have changed and say how it differs from before. */
  private async measurePage(
    before: PageSnapshot
  ): Promise<{ url: string; changes: string[] } | undefined> {
    const browser = this.deps.browser
    if (!browser) return undefined
    try {
      await browser.reload()
      const after = await browser.snapshot()
      return after ? { url: after.url, changes: diffPages(before, after) } : undefined
    } catch (e) {
      this.deps.log?.('[whiteboard] could not measure the page after the build', e)
      return undefined
    }
  }

  // ---- persistence

  private scheduleSave(): void {
    const workspace = this.workspace
    if (!workspace) return
    if (this.saveTimer) clearTimeout(this.saveTimer)
    const gen = this.generation
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      if (gen !== this.generation) return
      void this.deps
        .save(workspace, this.serialize())
        .catch((e) => this.deps.log?.('[whiteboard] save failed', e))
    }, 500)
  }

  /** Write a pending save now, to the workspace it belongs to. */
  async flush(): Promise<void> {
    if (!this.saveTimer || !this.workspace) return
    clearTimeout(this.saveTimer)
    this.saveTimer = null
    await this.deps.save(this.workspace, this.serialize()).catch(() => {})
  }

  serialize(): string {
    const lastBuild = this.lastBuild
      ? {
          ...this.lastBuild,
          diff: this.lastBuild.diff.length > MAX_SAVED_DIFF ? '' : this.lastBuild.diff
        }
      : null
    const saved: Saved = {
      version: 1,
      board: this.board.toJSON(),
      history: this.history,
      entries: this.entries,
      lastBuild,
      pendingCheckpoint: this.pendingCheckpoint
    }
    return JSON.stringify(saved)
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function isMsg(m: unknown): m is Msg {
  const x = m as Msg
  return !!x && (x.role === 'user' || x.role === 'assistant') && typeof x.content === 'string'
}

function isEntry(e: unknown): e is TranscriptEntry {
  const x = e as TranscriptEntry
  return (
    !!x &&
    typeof x.id === 'number' &&
    typeof x.text === 'string' &&
    ['you', 'narrator', 'info'].includes(x.who) &&
    (x.at === undefined || typeof x.at === 'number') &&
    (x.session === undefined || x.session === null || typeof x.session === 'string')
  )
}

function isLastBuild(b: unknown): b is LastBuild {
  const x = b as LastBuild
  return (
    !!x && typeof x.brief === 'string' && Array.isArray(x.diagrams) && typeof x.diff === 'string'
  )
}
