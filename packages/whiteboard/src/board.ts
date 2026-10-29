// The whiteboard's model: pages and the things drawn on them, in page units.
//
// This is the source of truth for the board. The tldraw view in the renderer
// is only a renderer: `apply(cmd)` updates the model and returns the visual
// effects (add / update / fade / delete / pulse / page) for the view to
// animate, and a remounted view rebuilds itself from the model without
// animation. Keeping layout decisions here — free-cell placement, arrows that
// curve around boxes, a picked option erasing its comparison — is what lets
// the replay tests check "no overlapping boxes" and "arrows stay on their
// page" in plain Node.
//
// Ported from the prototype's renderer (~/projects/anim/canvas/src/main.tsx),
// where the same rules lived in module-level maps beside tldraw calls.

import { GRID, type Cell, type Cmd, type Color, type Geo, type ShotImage } from './protocol'

export interface Page {
  id: string
  name: string
}

interface Base {
  id: string
  page: string
  opacity: number
}

export interface BoxEl extends Base {
  kind: 'box'
  name: string
  x: number
  y: number
  w: number
  h: number
  label: string
  color: Color
  geo: Geo
  link?: string
  // Set while the box is one side of a trade-off; cleared once a picked
  // option moves into the design.
  option?: { pros: string[]; cons: string[] }
  picked?: boolean
}

export interface ArrowEl extends Base {
  kind: 'arrow'
  name: string
  from: string
  to: string
  label: string
  bend: number
  dashed: boolean
}

export interface TextEl extends Base {
  kind: 'text'
  x: number
  y: number
  text: string
  color: Color
  size: 's' | 'l'
  role: 'title' | 'note' | 'pro' | 'con'
  // For pros/cons: the option they belong to.
  owner?: string
}

export interface GroupEl extends Base {
  kind: 'group'
  name: string
  x: number
  y: number
  w: number
  h: number
  label: string
}

/** A screenshot of the page beside the board, in a labelled frame. */
export interface ShotEl extends Base {
  kind: 'shot'
  name: string
  x: number
  y: number
  w: number
  h: number
  label: string
  image: ShotImage
  /** Bumped when the picture is retaken, so the view swaps it. */
  rev: number
}

export type El = BoxEl | ArrowEl | TextEl | GroupEl | ShotEl

export type Effect =
  | { fx: 'page'; page: Page }
  | { fx: 'rename'; page: Page }
  | { fx: 'add'; el: El; ms: number }
  | { fx: 'update'; el: El; ms: number }
  | { fx: 'fade'; ids: string[]; opacity: number; ms: number }
  | { fx: 'delete'; ids: string[]; ms: number }
  | { fx: 'pulse'; id: string; ms: number }
  /** A ring drawn around an area for a moment, then gone; nothing is added to the board. */
  | { fx: 'circle'; page: string; bounds: Bounds; ms: number }

export interface BoardState {
  version: 1
  pages: Page[]
  current: string
  els: El[]
  seq: number
  // Options laid out on each page since its last pick.
  weighing: Record<string, string[]>
  // For each picked option (`page/name`), the alternatives it beat.
  rivals: Record<string, string[]>
  // Every option name ever offered: `pick` may only name one of these.
  offered: string[]
  bends: number
}

export interface Bounds {
  x: number
  y: number
  w: number
  h: number
}

const MARGIN = 20
const TITLE_Y = -150
const NOTE_H = 40
const OPTION_NOTES_H = 130
/** A screenshot spans two cells each way, at most. */
const SHOT_MAX = { w: GRID.col + GRID.w, h: GRID.row + GRID.h }
/** Screenshots per board; each is a file on disk. */
export const MAX_SHOTS = 12

export function emptyBoard(): BoardState {
  return {
    version: 1,
    pages: [{ id: 'p1', name: '' }],
    current: 'p1',
    els: [],
    seq: 1,
    weighing: {},
    rivals: {},
    offered: [],
    bends: 0
  }
}

/** Rough on-board size of a text element; good enough to keep things apart. */
export function textBounds(t: TextEl): Bounds {
  const charW = t.size === 'l' ? 17 : 9
  return {
    x: t.x,
    y: t.y,
    w: Math.max(40, t.text.length * charW + 12),
    h: t.size === 'l' ? 50 : 30
  }
}

export function boundsOf(el: El): Bounds | null {
  if (el.kind === 'box' || el.kind === 'group' || el.kind === 'shot')
    return { x: el.x, y: el.y, w: el.w, h: el.h }
  if (el.kind === 'text') return textBounds(el)
  return null
}

const center = (b: Bounds): [number, number] => [b.x + b.w / 2, b.y + b.h / 2]

function overlaps(a: Bounds, b: Bounds, m = 0): boolean {
  return a.x < b.x + b.w + m && a.x + a.w > b.x - m && a.y < b.y + b.h + m && a.y + a.h > b.y - m
}

export class BoardModel {
  private s: BoardState

  constructor(state?: BoardState) {
    this.s = state ? structuredClone(state) : emptyBoard()
  }

  /** A model from saved JSON; anything malformed starts a fresh board instead of throwing. */
  static fromJSON(value: unknown): BoardModel {
    return new BoardModel(isBoardState(value) ? value : undefined)
  }

  toJSON(): BoardState {
    return structuredClone(this.s)
  }

  get pages(): Page[] {
    return this.s.pages.map((p) => ({ ...p }))
  }

  get currentPage(): Page {
    return { ...this.page(this.s.current) }
  }

  /** Elements on a page (default: the current one), in drawing order. */
  elements(page = this.s.current): El[] {
    return this.s.els.filter((e) => e.page === page)
  }

  /** Whether the board has nothing on it yet and only its unnamed first page. */
  get isBlank(): boolean {
    return this.s.els.length === 0 && this.s.pages.length === 1 && !this.s.pages[0].name
  }

  /** Every option name ever offered in this conversation. */
  get offered(): string[] {
    return [...this.s.offered]
  }

  /** A named box, group, screenshot or arrow on a page (default: the current one). */
  named(name: string, page = this.s.current): BoxEl | GroupEl | ShotEl | ArrowEl | undefined {
    return this.s.els.find(
      (e): e is BoxEl | GroupEl | ShotEl | ArrowEl =>
        e.kind !== 'text' && e.page === page && e.name === name
    )
  }

  /** Show a page by id (the person clicked its tab). */
  showPage(id: string): Effect[] {
    if (!this.s.pages.some((p) => p.id === id) || id === this.s.current) return []
    this.s.current = id
    return [{ fx: 'page', page: this.currentPage }]
  }

  apply(cmd: Cmd): Effect[] {
    switch (cmd.op) {
      case 'page':
        return this.turnTo(cmd.name)
      case 'box':
        return this.box(cmd)
      case 'option':
        return this.option(cmd)
      case 'arrow':
        return this.arrow(cmd)
      case 'note': {
        const [c, r] = cmd.at
        const spot = this.freeSpot(c * GRID.col, r * GRID.row + 25, GRID.w, NOTE_H)
        const el = this.text({ ...spot, text: cmd.text, color: 'grey', size: 's', role: 'note' })
        return [{ fx: 'add', el, ms: cmd.text.length * 45 }]
      }
      case 'group': {
        const existing = this.named(cmd.name)
        if (existing) return [{ fx: 'pulse', id: existing.id, ms: 900 }]
        const [c0, r0] = cmd.from
        const [c1, r1] = cmd.to
        const el: GroupEl = {
          kind: 'group',
          id: this.idFor('group', cmd.name),
          page: this.s.current,
          name: cmd.name,
          x: c0 * GRID.col - 40,
          y: r0 * GRID.row - 50,
          w: (c1 - c0) * GRID.col + GRID.w + 80,
          h: (r1 - r0) * GRID.row + GRID.h + 100,
          label: cmd.label,
          opacity: 1
        }
        this.s.els.push(el)
        return [{ fx: 'add', el, ms: 400 }]
      }
      case 'pick':
        return this.pick(cmd.name)
      case 'highlight': {
        const el = this.named(cmd.name)
        return el ? [{ fx: 'pulse', id: el.id, ms: 900 }] : []
      }
      case 'move':
        return this.move(cmd.name, cmd.at)
      case 'remove':
        return this.remove(cmd.name)
      case 'clear':
        return this.clear()
      case 'link': {
        const el = this.named(cmd.name)
        if (!el || el.kind !== 'box') return []
        el.link = cmd.to
        return [{ fx: 'update', el: { ...el }, ms: 0 }]
      }
      case 'shot':
        return this.shot(cmd)
      case 'circle':
        return this.circle(cmd.name, cmd.on)
    }
  }

  // ---- commands

  private turnTo(rawName: string): Effect[] {
    const name = rawName.trim()
    const fx: Effect[] = []
    let page = this.s.pages.find((p) => p.name.toLowerCase() === name.toLowerCase())
    const current = this.page(this.s.current)
    if (!page && this.elements().length === 0) {
      // The board starts on an unnamed page; the first topic names it.
      current.name = name
      page = current
      fx.push({ fx: 'rename', page: { ...current } })
    }
    if (!page) {
      page = { id: `p${this.s.seq++}`, name }
      this.s.pages.push(page)
    }
    if (page.id !== this.s.current) {
      this.s.current = page.id
      fx.push({ fx: 'page', page: { ...page } })
    }
    if (!this.elements().some((e) => e.kind === 'text' && e.role === 'title')) {
      const el = this.text({
        x: 0,
        y: TITLE_Y,
        text: page.name,
        color: 'black',
        size: 'l',
        role: 'title'
      })
      fx.push({ fx: 'add', el, ms: 500 })
    }
    return fx
  }

  private box(cmd: Extract<Cmd, { op: 'box' }>): Effect[] {
    const existing = this.named(cmd.name)
    if (existing) {
      // A box that's already there is pointed at, not drawn twice.
      const fx: Effect[] = [{ fx: 'pulse', id: existing.id, ms: 900 }]
      if (existing.kind === 'box' && cmd.link && existing.link !== cmd.link) {
        existing.link = cmd.link
        fx.push({ fx: 'update', el: { ...existing }, ms: 0 })
      }
      return fx
    }
    const [c, r] = cmd.at
    const spot = this.freeSpot(c * GRID.col, r * GRID.row, GRID.w, GRID.h)
    const el: BoxEl = {
      kind: 'box',
      id: this.idFor('box', cmd.name),
      page: this.s.current,
      name: cmd.name,
      x: spot.x,
      y: spot.y,
      w: GRID.w,
      h: GRID.h,
      label: cmd.label,
      color: cmd.color,
      geo: cmd.geo,
      ...(cmd.link ? { link: cmd.link } : {}),
      opacity: 1
    }
    this.s.els.push(el)
    return [{ fx: 'add', el: { ...el }, ms: 400 }]
  }

  private shot(cmd: Extract<Cmd, { op: 'shot' }>): Effect[] {
    const image = cmd.image
    if (!image || image.width <= 0 || image.height <= 0) return []
    const existing = this.named(cmd.name)
    if (existing?.kind === 'shot') {
      // The same picture taken again (after a change): swap it in place.
      existing.image = image
      existing.rev++
      return [{ fx: 'update', el: { ...existing }, ms: 0 }]
    }
    if (existing) return [{ fx: 'pulse', id: existing.id, ms: 900 }]
    if (this.s.els.filter((e) => e.kind === 'shot').length >= MAX_SHOTS) return []
    const aspect = image.height / image.width
    const w = Math.round(Math.min(SHOT_MAX.w, SHOT_MAX.h / aspect))
    const h = Math.round(w * aspect)
    const [c, r] = cmd.at
    const spot = this.freeSpot(c * GRID.col, r * GRID.row, w, h)
    const el: ShotEl = {
      kind: 'shot',
      id: this.idFor('shot', cmd.name),
      page: this.s.current,
      name: cmd.name,
      x: spot.x,
      y: spot.y,
      w,
      h,
      label: cmd.label,
      image,
      rev: 1,
      opacity: 1
    }
    this.s.els.push(el)
    return [{ fx: 'add', el: { ...el }, ms: 500 }]
  }

  private circle(name: string, on?: string): Effect[] {
    const el = this.named(name)
    if (!el || el.kind === 'arrow') return []
    let bounds: Bounds = { x: el.x, y: el.y, w: el.w, h: el.h }
    if (on) {
      // One element of a screenshot, by its text: exact first, then a close match.
      if (el.kind !== 'shot') return []
      const want = on.toLowerCase()
      const marks = el.image.marks
      const mark =
        marks.find((m) => m.text.toLowerCase() === want) ??
        marks.find((m) => m.text.toLowerCase().includes(want))
      if (!mark) return []
      bounds = {
        x: el.x + mark.x * el.w,
        y: el.y + mark.y * el.h,
        w: mark.w * el.w,
        h: mark.h * el.h
      }
    }
    return [{ fx: 'circle', page: this.s.current, bounds, ms: 2400 }]
  }

  private option(cmd: Extract<Cmd, { op: 'option' }>): Effect[] {
    const existing = this.named(cmd.name)
    if (existing) return [{ fx: 'pulse', id: existing.id, ms: 900 }]
    const [c, r] = cmd.at
    // Room for the box and the pros and cons written under it.
    const spot = this.freeSpot(c * GRID.col, r * GRID.row, GRID.w, GRID.h + OPTION_NOTES_H)
    const el: BoxEl = {
      kind: 'box',
      id: this.idFor('box', cmd.name),
      page: this.s.current,
      name: cmd.name,
      x: spot.x,
      y: spot.y,
      w: GRID.w,
      h: GRID.h,
      label: cmd.label,
      color: cmd.color,
      geo: 'rectangle',
      option: { pros: cmd.pros, cons: cmd.cons },
      opacity: 1
    }
    this.s.els.push(el)
    const fx: Effect[] = [{ fx: 'add', el: { ...el }, ms: 300 }]
    const lines = [
      ...cmd.pros.map((t) => ({ text: `+ ${t}`, color: 'green' as const, role: 'pro' as const })),
      ...cmd.cons.map((t) => ({ text: `− ${t}`, color: 'red' as const, role: 'con' as const }))
    ]
    lines.forEach((line, i) => {
      const note = this.text({
        x: spot.x + 6,
        y: spot.y + GRID.h + 14 + i * 30,
        text: line.text,
        color: line.color,
        size: 's',
        role: line.role,
        owner: cmd.name
      })
      fx.push({ fx: 'add', el: note, ms: line.text.length * 25 })
    })
    const weighing = (this.s.weighing[this.s.current] ??= [])
    if (!weighing.includes(cmd.name)) weighing.push(cmd.name)
    if (!this.s.offered.includes(cmd.name)) this.s.offered.push(cmd.name)
    return fx
  }

  private arrow(cmd: Extract<Cmd, { op: 'arrow' }>): Effect[] {
    // Arrows only join boxes on this page; a name from another page draws nothing.
    const a = this.named(cmd.from)
    const b = this.named(cmd.to)
    if (!a || !b || a.kind === 'arrow' || b.kind === 'arrow') return []
    const name = `${cmd.from}->${cmd.to}`
    const existing = this.named(name)
    if (existing) return [{ fx: 'pulse', id: existing.id, ms: 900 }]
    let bend = 0
    if (cmd.back) bend = -60
    else {
      // An arrow that would run through another box curves around it instead (alternating sides).
      const pa = center(a)
      const pb = center(b)
      if (this.crossesBox(pa, pb, [a.id, b.id])) {
        const dist = Math.hypot(pb[0] - pa[0], pb[1] - pa[1])
        bend = (this.s.bends++ % 2 ? 1 : -1) * Math.min(160, 50 + dist * 0.12)
      }
    }
    const el: ArrowEl = {
      kind: 'arrow',
      id: this.idFor('arrow', name),
      page: this.s.current,
      name,
      from: cmd.from,
      to: cmd.to,
      label: cmd.label,
      bend,
      dashed: cmd.back,
      opacity: 1
    }
    this.s.els.push(el)
    return [{ fx: 'add', el: { ...el }, ms: 700 }]
  }

  private pick(name: string): Effect[] {
    // Only an option that was actually offered on this page can be picked.
    const el = this.named(name)
    if (!el || el.kind !== 'box' || !el.option) return []
    const page = this.s.current
    const weighing = this.s.weighing[page] ?? []
    const rivals = weighing.includes(name) ? weighing.filter((n) => n !== name) : []
    el.color = 'green'
    el.picked = true
    if (!el.label.startsWith('✓')) el.label = `✓ ${el.label}`
    const fade = rivals.flatMap((n) => {
      const r = this.named(n)
      return r ? [r.id, ...this.notesOf(n).map((t) => t.id)] : []
    })
    for (const id of fade) {
      const f = this.s.els.find((e) => e.id === id)
      if (f) f.opacity = 0.3
    }
    this.s.rivals[`${page}/${name}`] = rivals
    this.s.weighing[page] = []
    const fx: Effect[] = [{ fx: 'update', el: { ...el }, ms: 0 }]
    if (fade.length) fx.push({ fx: 'fade', ids: fade, opacity: 0.3, ms: 600 })
    return fx
  }

  private move(name: string, at: Cell): Effect[] {
    const el = this.named(name)
    if (!el || el.kind === 'arrow') return []
    const fx: Effect[] = []
    const page = this.s.current
    const key = `${page}/${name}`
    // Moving an option into the design ends its comparison: its pros and cons,
    // and the alternatives it beat, are erased.
    if (el.kind === 'box' && el.option) {
      const rivals = this.s.rivals[key] ?? []
      const gone = [
        ...this.notesOf(name),
        ...rivals.flatMap((n) => {
          const r = this.named(n)
          return r ? [r, ...this.notesOf(n)] : []
        })
      ]
      const goneIds = new Set(gone.map((g) => g.id))
      // Arrows into an erased rival go with it.
      for (const e of this.elements()) {
        if (e.kind === 'arrow' && (rivals.includes(e.from) || rivals.includes(e.to)))
          goneIds.add(e.id)
      }
      if (goneIds.size) {
        this.s.els = this.s.els.filter((e) => !goneIds.has(e.id))
        fx.push({ fx: 'delete', ids: [...goneIds], ms: 250 })
      }
      delete this.s.rivals[key]
      for (const n of rivals) delete this.s.rivals[`${page}/${n}`]
      this.s.weighing[page] = (this.s.weighing[page] ?? []).filter(
        (n) => n !== name && !rivals.includes(n)
      )
      delete el.option
    }
    const [c, r] = at
    const spot = this.freeSpot(c * GRID.col, r * GRID.row, el.w, el.h, [el.id])
    el.x = spot.x
    el.y = spot.y
    fx.push({ fx: 'update', el: { ...el }, ms: 300 })
    return fx
  }

  private remove(name: string): Effect[] {
    const el = this.named(name)
    if (!el) return []
    const page = this.s.current
    const gone = new Set<string>([el.id])
    if (el.kind !== 'arrow') {
      // Its arrows would be left dangling, and its pros and cons orphaned.
      for (const e of this.elements()) {
        if (e.kind === 'arrow' && (e.from === name || e.to === name)) gone.add(e.id)
      }
      for (const t of this.notesOf(name)) gone.add(t.id)
      this.s.weighing[page] = (this.s.weighing[page] ?? []).filter((n) => n !== name)
      delete this.s.rivals[`${page}/${name}`]
    }
    this.s.els = this.s.els.filter((e) => !gone.has(e.id))
    return [{ fx: 'delete', ids: [...gone], ms: 300 }]
  }

  private clear(): Effect[] {
    // Wipes the drawing on the current page; its title stays.
    const page = this.s.current
    const gone = this.elements()
      .filter((e) => !(e.kind === 'text' && e.role === 'title'))
      .map((e) => e.id)
    this.s.els = this.s.els.filter((e) => !gone.includes(e.id))
    this.s.weighing[page] = []
    for (const key of Object.keys(this.s.rivals)) {
      if (key.startsWith(`${page}/`)) delete this.s.rivals[key]
    }
    return gone.length ? [{ fx: 'delete', ids: gone, ms: 300 }] : []
  }

  // ---- layout

  /**
   * Where a new box (or note) can go without covering anything: its own grid
   * cell if that's free, otherwise the nearest free cell, preferring right
   * and down. The model doesn't always keep track of which cells are taken.
   */
  freeSpot(
    x: number,
    y: number,
    w: number,
    h: number,
    skip: string[] = []
  ): { x: number; y: number } {
    const taken = this.elements()
      .filter(
        (e) =>
          !skip.includes(e.id) &&
          (e.kind === 'box' || e.kind === 'shot' || (e.kind === 'text' && e.role !== 'title'))
      )
      .map(boundsOf)
      .filter((b): b is Bounds => b !== null)
    const free = (px: number, py: number): boolean =>
      !taken.some((b) => overlaps({ x: px, y: py, w, h }, b, MARGIN))
    if (free(x, y)) return { x, y }
    const tries: [number, number][] = []
    for (let dr = 0; dr <= 4; dr++) for (let dc = -3; dc <= 5; dc++) tries.push([dc, dr])
    tries.sort((a, b) => Math.abs(a[0]) + a[1] - (Math.abs(b[0]) + b[1]) || b[0] - a[0])
    for (const [dc, dr] of tries) {
      const px = x + dc * GRID.col
      const py = y + dr * GRID.row
      if (px >= 0 && py >= 0 && free(px, py)) return { x: px, y: py }
    }
    // A crowded board: keep going down until there's room.
    for (let dr = 5; dr < 60; dr++) {
      const py = y + dr * GRID.row
      if (free(x, py)) return { x, y: py }
    }
    return { x, y }
  }

  /** Whether the straight line from a to b crosses a box (other than the ones it connects). */
  private crossesBox(a: [number, number], b: [number, number], skip: string[]): boolean {
    const boxes = this.elements()
      .filter(
        (e): e is BoxEl | ShotEl => (e.kind === 'box' || e.kind === 'shot') && !skip.includes(e.id)
      )
      .map((e) => ({ x: e.x, y: e.y, w: e.w, h: e.h }))
    for (let i = 1; i < 20; i++) {
      const x = a[0] + ((b[0] - a[0]) * i) / 20
      const y = a[1] + ((b[1] - a[1]) * i) / 20
      if (boxes.some((r) => x > r.x - 8 && x < r.x + r.w + 8 && y > r.y - 8 && y < r.y + r.h + 8)) {
        return true
      }
    }
    return false
  }

  // ---- describing the board to the model

  /**
   * What's on the board, in the grid terms the model draws with (so new
   * things go in empty cells): the pages, everything on the current one, and
   * the boxes on the others.
   */
  describe(): string {
    const lines: string[] = []
    const pages = this.s.pages
    if (pages.length > 1 || pages[0]?.name) {
      lines.push(
        `pages: ${pages
          .map((p) => `"${p.name || '(unnamed)'}"${p.id === this.s.current ? ' (current)' : ''}`)
          .join(', ')}`
      )
    }
    for (const e of this.elements()) lines.push(describeEl(e))
    for (const page of pages.filter((p) => p.id !== this.s.current)) {
      const boxes = this.elements(page.id)
        .filter((e): e is BoxEl => e.kind === 'box')
        .map((b) => `${b.name} ${JSON.stringify(b.label)}`)
      lines.push(
        `on page "${page.name || '(unnamed)'}" (not current): ${boxes.join(', ') || 'nothing yet'}`
      )
    }
    return lines.join('\n')
  }

  /**
   * Every page in words, for the builder's brief: what the person and the
   * narrator agreed on, without grid coordinates.
   */
  describePages(): string {
    const out: string[] = []
    for (const page of this.s.pages) {
      const els = this.elements(page.id)
      if (!els.length) continue
      out.push(`Page "${page.name || 'Untitled'}":`)
      for (const e of els) {
        if (e.kind === 'box') {
          const state = e.picked
            ? ' (chosen)'
            : e.option
              ? e.opacity < 1
                ? ' (rejected option)'
                : ' (option, undecided)'
              : ''
          out.push(`- ${e.label.replace(/^✓\s*/, '')}${state}${e.link ? ` [${e.link}]` : ''}`)
        } else if (e.kind === 'arrow') {
          const from = this.named(e.from, page.id)
          const to = this.named(e.to, page.id)
          const name = (x: typeof from, fallback: string): string =>
            x && x.kind !== 'arrow' ? x.label.replace(/^✓\s*/, '') : fallback
          out.push(
            `- ${name(from, e.from)} → ${name(to, e.to)}${e.label ? ` (${e.label})` : ''}${e.dashed ? ', return path' : ''}`
          )
        } else if (e.kind === 'group') {
          out.push(`- Group: ${e.label}`)
        } else if (e.kind === 'shot') {
          out.push(`- Screenshot of the running app: ${e.label}`)
        } else if (e.role === 'note') {
          out.push(`- Note: ${e.text}`)
        }
      }
    }
    return out.join('\n')
  }

  // ---- helpers

  private page(id: string): Page {
    const p = this.s.pages.find((x) => x.id === id)
    if (!p) throw new Error(`whiteboard: unknown page ${id}`)
    return p
  }

  private idFor(kind: 'box' | 'arrow' | 'group' | 'shot', name: string): string {
    return `${this.s.current}~${kind}~${name}`
  }

  private text(t: Omit<TextEl, 'kind' | 'id' | 'page' | 'opacity'>): TextEl {
    const el: TextEl = {
      kind: 'text',
      id: `${this.s.current}~t~${this.s.seq++}`,
      page: this.s.current,
      opacity: 1,
      ...t
    }
    this.s.els.push(el)
    return { ...el }
  }

  private notesOf(option: string, page = this.s.current): TextEl[] {
    return this.s.els.filter(
      (e): e is TextEl => e.kind === 'text' && e.page === page && e.owner === option
    )
  }
}

const at = (x: number, y: number): string =>
  `[${Math.round(x / GRID.col)},${Math.round(y / GRID.row)}]`

function describeEl(e: El): string {
  switch (e.kind) {
    case 'box': {
      const kind = e.option ? 'option' : 'box'
      const extra = [
        e.geo === 'rectangle' ? '' : e.geo,
        e.picked ? 'picked' : '',
        e.option && e.opacity < 1 ? 'not chosen' : '',
        e.link ? `links to ${e.link}` : ''
      ].filter(Boolean)
      return `${kind} ${e.name} ${JSON.stringify(e.label)} at ${at(e.x, e.y)} ${e.color}${extra.length ? ` ${extra.join(', ')}` : ''}`
    }
    case 'arrow':
      return `arrow ${e.name}${e.label ? ` ${JSON.stringify(e.label)}` : ''}${e.dashed ? ' (back)' : ''}`
    case 'shot': {
      const span = (size: number, step: number, unit: number): number =>
        Math.max(1, Math.ceil((size - unit) / step - 0.01) + 1)
      const cells = `${span(e.w, GRID.col, GRID.w)}x${span(e.h, GRID.row, GRID.h)}`
      const marks = e.image.marks.length
        ? `; circle its parts with "on": ${e.image.marks
            .slice(0, 12)
            .map((m) => JSON.stringify(m.text))
            .join(', ')}`
        : ''
      return `shot ${e.name} ${JSON.stringify(e.label)} at ${at(e.x, e.y)}, a screenshot of the page covering ${cells} cells${marks}`
    }
    case 'group':
      return `group ${e.name} ${JSON.stringify(e.label)} from ${at(e.x + 40, e.y + 50)} to ${at(e.x + e.w - 40 - GRID.w, e.y + e.h - 50 - GRID.h)}`
    case 'text':
      if (e.role === 'title') return `title ${JSON.stringify(e.text)}`
      if (e.role === 'note') return `note ${JSON.stringify(e.text)} at ${at(e.x, e.y - 25)}`
      return `${e.role} of ${e.owner}: ${JSON.stringify(e.text.slice(2))}`
  }
}

function isBoardState(v: unknown): v is BoardState {
  if (!v || typeof v !== 'object') return false
  const s = v as Partial<BoardState>
  return (
    s.version === 1 &&
    Array.isArray(s.pages) &&
    s.pages.length > 0 &&
    s.pages.every((p) => p && typeof p.id === 'string' && typeof p.name === 'string') &&
    typeof s.current === 'string' &&
    s.pages.some((p) => p.id === s.current) &&
    Array.isArray(s.els) &&
    s.els.every((e) => e && typeof e.id === 'string' && typeof e.page === 'string') &&
    typeof s.seq === 'number' &&
    typeof s.weighing === 'object' &&
    typeof s.rivals === 'object' &&
    Array.isArray(s.offered) &&
    typeof s.bends === 'number'
  )
}
