// One narrator turn: ask, then speak each sentence while drawing it.
//
// Pareto doesn't stream: every request comes back in one burst, about 2 s
// plus 18 ms per output token. So a turn sends two requests at once:
//
// - a tiny *opener* (one sentence, back in 1.5-2.5 s) that is spoken while
// - the *main* answer is still being generated. The main answer arrives in
//   parts of at most three sentences; each next part is requested the moment
//   the previous one arrives, so it's ready before the current part finishes
//   speaking.
//
// Drawing lines wait until the opener has played. The opener is kept to one
// sentence, an answer that opens by repeating it loses the repeat (but keeps
// its drawing), and each sentence's drawing plays while it's spoken.
//
// The speech engine, the canvas and the model transport are all injected, so
// this runs (and is tested) in plain Node. Ported from the prototype's
// talk.tsx.

import { asksForChange, asksToClear, agreesToBuild, similar } from './guards'
import { toPageCmd, type PageCmd } from './page'
import { AFTER_OPENER, type NarratorMode } from './prompts'
import { parseReply, toBuild, toCmd, toResearch, toSay, type Cmd, type RawLine } from './protocol'

export interface Msg {
  role: 'user' | 'assistant'
  content: string
}

/** What plays alongside a sentence: drawing on the board, or pointing at the page beside it. */
export type Action = Cmd | PageCmd

export interface Segment {
  say: string
  cmds: Action[]
  filler?: boolean
}

/** One hidden narrator session. `send` resolves with the whole reply. */
export interface NarratorConversation {
  send(text: string, signal: AbortSignal): Promise<string>
  /** The turn is done with it (e.g. delete the hidden session). Best-effort. */
  close?(): void
}

export interface NarratorTransport {
  /** A conversation for this mode, ideally from a pool created ahead of time. */
  open(mode: NarratorMode): Promise<NarratorConversation>
}

export interface Speaker {
  /**
   * A sentence that will be spoken soon. Engines that synthesize audio (the
   * natural voice) start on it now, so the next sentence is ready while the
   * current one plays. Called in speaking order.
   */
  prepare?(text: string): void
  /** Speak one sentence; `onStart` fires when sound (or the caption) begins. */
  speak(text: string, onStart?: () => void): Promise<void>
  /** Stop speaking now (the person interrupted). */
  cancel(): void
}

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface TurnDeps {
  transport: NarratorTransport
  speaker: Speaker
  /** Draw one command, or point at the page. Errors are logged and the turn carries on. */
  run(cmd: Action): Promise<void>
  /** The <canvas> summary, read fresh for every request. */
  describe(): string
  /** The <project> block (real diagram names and paths), if any. */
  project?(): string
  /** The <page> block (the web page beside the board, page.ts formatPage), if any. */
  page?(): string
  /** The <files> block: workspace files the question names (files.ts formatFiles), if any. */
  files?(): string
  /** A sentence started: captions and the transcript. */
  onSaid?(text: string, segment: Segment): void
  clock?: Clock
  delays?: Partial<typeof DEFAULT_DELAYS>
  log?(message: string, error?: unknown): void
}

export interface TurnRequest {
  question: string
  history: Msg[]
  mode: 'talk' | 'walkthrough'
  /** Walkthrough mode: the <checkpoint> block's contents. */
  checkpoint?: string
  /**
   * Something was just built in this conversation, so a direct request to
   * change it ("make them even wider") counts as the go-ahead to build.
   */
  followUp?: boolean
  /**
   * The <research> block: what the read-only agent found for an earlier
   * question. A turn that reports research can't start another.
   */
  research?: string
}

export interface TurnTiming {
  /** ms from the question to the first sound (a filler counts). */
  firstSpoken?: number
  /** ms to the first real sentence (opener or answer). */
  firstAnswerSpoken?: number
  /** ms to the first drawing command. */
  firstDrawing?: number
  /** ms until the opener's reply arrived. */
  opener?: number
  /** ms until each main part arrived. */
  parts: number[]
  /** Longest silence between two sentences after the first one, in ms. */
  maxGap: number
  total: number
}

export interface TurnResult {
  aborted: boolean
  /** Everything kept from the reply (opener and parts), as lines, for history. */
  reply: string
  /** The design brief, when a build line passed the guard. */
  build: string | null
  /** A build line arrived without the person's yes and was dropped. */
  buildRefused: boolean
  /** A question for the read-only agent to look into, from a research line. */
  research: string | null
  segments: Segment[]
  timing: TurnTiming
  error?: string
}

export const DEFAULT_DELAYS = {
  /** Fill the silence if nothing has arrived by then. */
  filler: 1800,
  /** The answer's lines stop waiting for a slow opener after this. */
  gate: 6000
}

/** The longest reply we'll keep asking for, in parts. */
export const MAX_PARTS = 6
/** How many earlier messages each request carries. */
export const HISTORY_MAIN = 16
export const HISTORY_OPENER = 4

/** Said when the first part of an answer is slow to arrive (exported so a voice can pre-render them). */
export const FILLERS = [
  'Hmm, let me sketch it.',
  'Okay, let me draw this out.',
  'Let me show you.',
  'Right, let me sketch that.'
]
let fillerIndex = 0

export const WALKTHROUGH_OPENER = "It's built. Let me show you what changed."
export const CONFIRM_BUILD = 'Before I build anything, do you want me to go ahead with this design?'

const defaultClock: Clock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

/** A request's text: earlier turns, the project, the question and the board. */
export function composePrompt(opts: {
  question: string
  history: Msg[]
  historyLimit: number
  canvas: string
  project?: string
  page?: string
  files?: string
  research?: string
  checkpoint?: string
  afterOpener?: boolean
}): string {
  const out: string[] = []
  const history = opts.historyLimit > 0 ? opts.history.slice(-opts.historyLimit) : []
  if (history.length) {
    const turns = history.map((m) =>
      m.role === 'user' ? `Person: ${m.content}` : `You:\n${m.content}`
    )
    out.push(`<conversation>\n${turns.join('\n')}\n</conversation>`)
  }
  if (opts.project?.trim()) out.push(`<project>\n${opts.project.trim()}\n</project>`)
  if (opts.page?.trim()) out.push(`<page>\n${opts.page.trim()}\n</page>`)
  if (opts.files?.trim()) out.push(`<files>\n${opts.files.trim()}\n</files>`)
  if (opts.research?.trim()) out.push(`<research>\n${opts.research.trim()}\n</research>`)
  if (opts.checkpoint?.trim()) out.push(`<checkpoint>\n${opts.checkpoint.trim()}\n</checkpoint>`)
  out.push(opts.question)
  if (opts.afterOpener) out.push(AFTER_OPENER)
  out.push(`<canvas>\n${opts.canvas.trim() || '(empty)'}\n</canvas>`)
  return out.join('\n\n')
}

/** The prompt for a follow-up part in the same main session. */
export function continuePrompt(canvas: string): string {
  return `(continue)\n\n<canvas>\n${canvas.trim() || '(empty)'}\n</canvas>`
}

export class Turn {
  readonly done: Promise<TurnResult>
  private readonly segs: Segment[] = []
  private finished = false
  private aborted = false
  private readonly ctl = new AbortController()
  private wake: () => void = () => {}
  private readonly clock: Clock
  private readonly delays: typeof DEFAULT_DELAYS
  private readonly t0: number
  private readonly timing: TurnTiming = { parts: [], maxGap: 0, total: 0 }
  private readonly kept: string[] = []
  private readonly mayClear: boolean
  private build: string | null = null
  private research: string | null = null
  private buildRefused = false
  private readonly convs: NarratorConversation[] = []
  private error: string | undefined

  constructor(
    private readonly deps: TurnDeps,
    private readonly req: TurnRequest
  ) {
    this.clock = deps.clock ?? defaultClock
    this.delays = { ...DEFAULT_DELAYS, ...deps.delays }
    this.t0 = this.clock.now()
    this.mayClear = req.mode === 'talk' && asksToClear(req.question)
    this.done = this.start()
  }

  /** Stop talking and drawing right now (the person is speaking or pressed Esc). */
  interrupt(): void {
    if (this.aborted || this.finished) return
    this.aborted = true
    this.ctl.abort()
    this.notify()
    this.deps.speaker.cancel()
  }

  get isAborted(): boolean {
    return this.aborted
  }

  private notify(): void {
    const w = this.wake
    this.wake = () => {}
    w()
  }

  private changed(): Promise<void> {
    return new Promise<void>((r) => (this.wake = r))
  }

  private since(): number {
    return Math.round(this.clock.now() - this.t0)
  }

  private async start(): Promise<TurnResult> {
    const player = this.play()
    const filler = this.clock.setTimeout(() => {
      if (this.segs.length || this.aborted) return
      const say = FILLERS[fillerIndex++ % FILLERS.length]
      this.deps.speaker.prepare?.(say)
      this.segs.push({ say, cmds: [], filler: true })
      this.notify()
    }, this.delays.filler)

    // The opener plays first; the answer's lines wait for it, but not for long.
    let openGate!: () => void
    let gateOpen = false
    const gate = new Promise<void>((r) => {
      openGate = () => {
        gateOpen = true
        r()
      }
    })
    const gateTimer = this.clock.setTimeout(() => openGate(), this.delays.gate)

    let openerDone: Promise<void>
    if (this.req.mode === 'walkthrough') {
      // Nothing to wait for: the checkpoint is news the person is expecting.
      this.deps.speaker.prepare?.(WALKTHROUGH_OPENER)
      this.segs.push({ say: WALKTHROUGH_OPENER, cmds: [] })
      this.kept.push(JSON.stringify({ say: WALKTHROUGH_OPENER }))
      this.notify()
      openGate()
      openerDone = Promise.resolve()
    } else {
      openerDone = this.fetchOpener(() => gateOpen)
        .catch((e) => {
          if (!this.aborted) this.deps.log?.('[whiteboard] opener failed', e)
        })
        .finally(() => {
          this.clock.clearTimeout(gateTimer)
          openGate()
        })
    }

    try {
      const mode: NarratorMode = this.req.mode === 'walkthrough' ? 'walkthrough' : 'main'
      const conv = await this.deps.transport.open(mode)
      this.convs.push(conv)
      let prompt = composePrompt({
        question: this.req.question,
        history: this.req.history,
        historyLimit: HISTORY_MAIN,
        canvas: this.deps.describe(),
        project: this.deps.project?.(),
        page: this.deps.page?.(),
        files: this.deps.files?.(),
        research: this.req.research,
        checkpoint: this.req.checkpoint,
        afterOpener: this.req.mode === 'talk'
      })
      for (let n = 0; n < MAX_PARTS && !this.aborted; n++) {
        const reply = await conv.send(prompt, this.ctl.signal)
        this.timing.parts.push(this.since())
        if (n === 0) await gate
        if (this.aborted) break
        let more = false
        for (const line of parseReply(reply)) {
          if (this.take(line, false)) more = true
        }
        this.notify()
        if (!more) break
        prompt = continuePrompt(this.deps.describe())
      }
    } catch (e) {
      if (!this.aborted) {
        this.error = e instanceof Error ? e.message : String(e)
        this.deps.log?.('[whiteboard] narrator request failed', e)
      }
    }
    this.clock.clearTimeout(filler)
    this.clock.clearTimeout(gateTimer)
    await openerDone

    // A build line without the person's yes is dropped, and they're asked instead.
    if (this.buildRefused && !this.build && !this.aborted) {
      this.deps.speaker.prepare?.(CONFIRM_BUILD)
      this.segs.push({ say: CONFIRM_BUILD, cmds: [] })
      this.kept.push(JSON.stringify({ say: CONFIRM_BUILD }))
    }
    this.finished = true
    this.notify()
    await player
    for (const c of this.convs) {
      try {
        c.close?.()
      } catch (e) {
        this.deps.log?.('[whiteboard] closing a narrator session failed', e)
      }
    }
    this.timing.total = this.since()
    return {
      aborted: this.aborted,
      reply: this.kept.join('\n'),
      build: this.aborted ? null : this.build,
      buildRefused: this.buildRefused,
      research: this.aborted ? null : this.research,
      segments: this.segs.filter((s) => !s.filler),
      timing: this.timing,
      ...(this.error ? { error: this.error } : {})
    }
  }

  private async fetchOpener(late: () => boolean): Promise<void> {
    const conv = await this.deps.transport.open('opener')
    this.convs.push(conv)
    const prompt = composePrompt({
      question: this.req.question,
      history: this.req.history,
      historyLimit: HISTORY_OPENER,
      canvas: this.deps.describe()
    })
    const reply = await conv.send(prompt, this.ctl.signal)
    this.timing.opener = this.since()
    if (late() || this.aborted) return
    // The opener is one sentence; it sometimes runs on into a whole answer (or
    // draws), which is the main request's job.
    const first = parseReply(reply).find((l) => toSay(l))
    if (first) this.take(first, true)
    this.notify()
  }

  /** Queue one reply line for playing. Returns true for a {"more":true} line. */
  private take(line: RawLine, opener: boolean): boolean {
    if (line.more === true) return true
    const say = toSay(line)
    if (say !== null) {
      // The answer sometimes opens by repeating the opener: keep its drawing, not the repeat.
      const prev = this.segs.at(-1)
      if (!opener && prev && !prev.filler && prev.say && similar(prev.say, say)) return false
      this.deps.speaker.prepare?.(say)
      this.segs.push({ say, cmds: [] })
      this.kept.push(JSON.stringify({ say }))
      return false
    }
    if (opener) return false
    const brief = toBuild(line)
    if (brief !== null) {
      if (this.req.mode === 'talk' && this.mayBuild()) {
        this.build = brief
        this.kept.push(JSON.stringify({ build: brief }))
      } else if (this.req.mode === 'talk') {
        this.buildRefused = true
      }
      return false
    }
    const question = toResearch(line)
    if (question !== null) {
      // One look per turn, never from a walkthrough or while reporting one.
      if (this.req.mode === 'talk' && !this.req.research && !this.research) {
        this.research = question
        this.kept.push(JSON.stringify({ research: question }))
      }
      return false
    }
    const cmd = toPageCmd(line) ?? toCmd(line)
    if (!cmd) return false
    if (cmd.op === 'clear' && !this.mayClear) return false
    this.kept.push(JSON.stringify(line))
    const last = this.segs.at(-1)
    if (last && !last.filler) last.cmds.push(cmd)
    else this.segs.push({ say: '', cmds: [cmd] })
    return false
  }

  /** The person's message is a yes to building, or (right after a build) a direct change request. */
  private mayBuild(): boolean {
    const q = this.req.question
    return agreesToBuild(q) || (this.req.followUp === true && asksForChange(q))
  }

  /** Play the reply as it arrives: speak each sentence while running its drawing commands in order. */
  private async play(): Promise<void> {
    let lastSpeechEnd: number | null = null
    for (let si = 0; !this.aborted; si++) {
      while (!this.segs[si] && !this.finished && !this.aborted) await this.changed()
      const seg = this.segs[si]
      if (!seg || this.aborted) return
      const speech = seg.say
        ? this.deps.speaker
            .speak(seg.say, () => {
              const now = this.since()
              this.timing.firstSpoken ??= now
              if (!seg.filler) this.timing.firstAnswerSpoken ??= now
              if (lastSpeechEnd !== null)
                this.timing.maxGap = Math.max(this.timing.maxGap, now - lastSpeechEnd)
              this.deps.onSaid?.(seg.say, seg)
            })
            .catch((e) => this.deps.log?.('[whiteboard] speech failed', e))
            .then(() => {
              lastSpeechEnd = this.since()
            })
        : Promise.resolve()
      for (let i = 0; ;) {
        if (this.aborted) return
        if (i < seg.cmds.length) {
          const cmd = seg.cmds[i++]
          this.timing.firstDrawing ??= this.since()
          await this.deps.run(cmd).catch((e) => this.deps.log?.('[whiteboard] drawing failed', e))
          continue
        }
        if (this.segs[si + 1] || this.finished) break
        await this.changed()
      }
      await speech
    }
  }
}
