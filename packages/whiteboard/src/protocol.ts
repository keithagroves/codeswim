// The narrator's line protocol: one compact JSON object per line, on a grid.
//
// The model writes lines like {"box":"api","at":[1,0],"label":"API"}; this
// module parses them tolerantly and turns drawing lines into typed board
// commands (`Cmd`) the board model understands. Everything the model can get
// wrong in a way that would break the canvas — HTML in labels, colors tldraw
// doesn't have, shapes it doesn't know, paths that escape the workspace — is
// cleaned up here, in code, rather than trusted to the prompt.
//
// `say`, `more`, `build` and `research` lines are not drawing; the turn
// scheduler (turn.ts) handles them.

/** The board's grid in page units: column and row spacing, and the size of a box. */
export const GRID = { col: 380, row: 220, w: 200, h: 90 } as const

export const COLORS = [
  'black',
  'grey',
  'light-violet',
  'violet',
  'blue',
  'light-blue',
  'yellow',
  'orange',
  'green',
  'light-green',
  'light-red',
  'red',
  'white'
] as const
export type Color = (typeof COLORS)[number]

export const GEOS = [
  'rectangle',
  'ellipse',
  'diamond',
  'cloud',
  'hexagon',
  'oval',
  'trapezoid',
  'triangle',
  'star',
  'octagon',
  'pentagon',
  'rhombus'
] as const
export type Geo = (typeof GEOS)[number]

export type Cell = [col: number, row: number]

/** A raw line as the model wrote it. Fields are unvalidated until `toCmd`. */
export type RawLine = Record<string, unknown>

/** A validated drawing command, in grid terms. */
export type Cmd =
  | { op: 'box'; name: string; at: Cell; label: string; color: Color; geo: Geo; link?: string }
  | { op: 'arrow'; from: string; to: string; label: string; back: boolean }
  | { op: 'note'; at: Cell; text: string }
  | { op: 'group'; name: string; from: Cell; to: Cell; label: string }
  | {
      op: 'option'
      name: string
      at: Cell
      label: string
      pros: string[]
      cons: string[]
      color: Color
    }
  | { op: 'pick'; name: string }
  | { op: 'page'; name: string }
  | { op: 'highlight'; name: string }
  | { op: 'move'; name: string; at: Cell }
  | { op: 'remove'; name: string }
  | { op: 'clear' }
  | { op: 'link'; name: string; to: string }

/**
 * One reply line as an object, or null (code fences, stray brackets, broken
 * JSON). Plain prose with letters in it becomes a spoken sentence, because a
 * model that forgets the format mid-reply is still saying something useful.
 */
export function parseLine(raw: string): RawLine | null {
  const s = raw.trim()
  if (!s || s.startsWith('```') || s.startsWith('~~~')) return null
  if (s.startsWith('{')) {
    try {
      const o: unknown = JSON.parse(s)
      return o && typeof o === 'object' && !Array.isArray(o) ? (o as RawLine) : null
    } catch {
      return null
    }
  }
  // A bare bracket, comma or list marker on its own line is debris, not speech.
  return /[a-z]/i.test(s) ? { say: stripMarkup(s) } : null
}

/** Every line of a reply, parsed, in order. CRLF-safe. */
export function parseReply(text: string): RawLine[] {
  return text
    .split(/\r?\n/)
    .map(parseLine)
    .filter((l): l is RawLine => l !== null)
}

function stripMarkup(s: string): string {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/[`*_#{}<>[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Board text is a few plain words: no HTML, markdown or code. Cut at a word
 * boundary so a long label never ends mid-word.
 */
export function clean(value: unknown, max = 60): string {
  const t = stripMarkup(String(value ?? ''))
  if (t.length <= max) return t
  const cut = t.lastIndexOf(' ', max)
  return (cut > 0 ? t.slice(0, cut) : t.slice(0, max)).trim()
}

/** A shape name: short, lowercase, no spaces, so it is stable across turns. */
export function cleanName(value: unknown): string {
  return clean(value, 40).toLowerCase().replace(/\s+/g, '-')
}

/**
 * tldraw rejects (and crashes on) unknown colors, so near misses are mapped
 * and anything else falls back to a default.
 */
export function toColor(value: unknown, fallback: Color = 'blue'): Color {
  const s = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/gray/g, 'grey')
    .replace(/purple/g, 'violet')
    .replace(/pink/g, 'light-red')
    .replace(/\s+/g, '-')
  return (COLORS as readonly string[]).includes(s) ? (s as Color) : fallback
}

export function toGeo(value: unknown): Geo {
  const s = String(value ?? '')
    .trim()
    .toLowerCase()
  if (s === 'circle') return 'ellipse'
  if (s === 'box' || s === 'square' || s === 'rect') return 'rectangle'
  return (GEOS as readonly string[]).includes(s) ? (s as Geo) : 'rectangle'
}

const MAX_COL = 12
const MAX_ROW = 12

/** A grid cell, clamped to a sane board so a typo can't fling a box off-screen. */
export function toCell(at: unknown): Cell {
  if (!Array.isArray(at)) return [0, 0]
  const n = (v: unknown, max: number): number => {
    const x = Math.round(Number(v))
    return Number.isFinite(x) ? Math.max(0, Math.min(max, x)) : 0
  }
  return [n(at[0], MAX_COL), n(at[1], MAX_ROW)]
}

/**
 * A link target must be a workspace-relative POSIX path that stays inside the
 * workspace. Anything else (URLs, absolute paths, `..`) is dropped. This is
 * the cheap client-side check; whiteboard.openLink re-validates.
 */
export function toLink(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const s = value.trim().replace(/^\.\//, '')
  if (!s || s.length > 300) return undefined
  if (s.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(s) || s.includes('\\')) return undefined
  if (s.split('/').includes('..')) return undefined
  return s
}

function list(value: unknown, max = 2): string[] {
  return Array.isArray(value)
    ? value
        .slice(0, max)
        .map((t) => clean(t, 32))
        .filter(Boolean)
    : []
}

/** Turn one drawing line into a board command, or null when it isn't one. */
export function toCmd(o: RawLine): Cmd | null {
  if (typeof o.box === 'string' && o.box.trim()) {
    const link = toLink(o.link)
    return {
      op: 'box',
      name: cleanName(o.box),
      at: toCell(o.at),
      label: clean(o.label ?? o.box, 40),
      color: toColor(o.color),
      geo: toGeo(o.shape),
      ...(link ? { link } : {})
    }
  }
  if (Array.isArray(o.arrow) && o.arrow.length >= 2) {
    const [from, to] = o.arrow.map(cleanName)
    if (!from || !to || from === to) return null
    return { op: 'arrow', from, to, label: clean(o.label, 24), back: o.back === true }
  }
  if (typeof o.note === 'string' && o.note.trim()) {
    return { op: 'note', at: toCell(o.at), text: clean(o.note) }
  }
  if (typeof o.group === 'string' && o.group.trim()) {
    const from = toCell(o.from)
    const to = toCell(o.to ?? o.from)
    return {
      op: 'group',
      name: cleanName(o.group),
      from: [Math.min(from[0], to[0]), Math.min(from[1], to[1])],
      to: [Math.max(from[0], to[0]), Math.max(from[1], to[1])],
      label: clean(o.label ?? o.group, 30)
    }
  }
  if (typeof o.option === 'string' && o.option.trim()) {
    return {
      op: 'option',
      name: cleanName(o.option),
      at: toCell(o.at),
      label: clean(o.label ?? o.option, 40),
      pros: list(o.pros),
      cons: list(o.cons),
      color: toColor(o.color)
    }
  }
  if (typeof o.pick === 'string' && o.pick.trim()) return { op: 'pick', name: cleanName(o.pick) }
  if (typeof o.page === 'string' && clean(o.page, 30))
    return { op: 'page', name: clean(o.page, 30) }
  if (typeof o.highlight === 'string' && o.highlight.trim()) {
    return { op: 'highlight', name: cleanName(o.highlight) }
  }
  if (typeof o.move === 'string' && o.move.trim()) {
    return { op: 'move', name: cleanName(o.move), at: toCell(o.at) }
  }
  if (typeof o.remove === 'string' && o.remove.trim()) {
    // Arrows are addressed as "from->to"; keep the arrow intact.
    const name = o.remove.includes('->')
      ? o.remove.split('->').map(cleanName).join('->')
      : cleanName(o.remove)
    return { op: 'remove', name }
  }
  if (o.clear === true) return { op: 'clear' }
  if (typeof o.link === 'string' && o.link.trim() && typeof o.to === 'string') {
    const to = toLink(o.to)
    return to ? { op: 'link', name: cleanName(o.link), to } : null
  }
  return null
}

/** A spoken sentence, cleaned for speech: plain words, nothing the voice would read as symbols. */
export function toSay(o: RawLine): string | null {
  if (typeof o.say !== 'string') return null
  const s = stripMarkup(o.say)
  return /[a-z0-9]/i.test(s) ? s : null
}

/** The question in a research line (for the read-only agent), or null. */
export function toResearch(o: RawLine): string | null {
  if (typeof o.research !== 'string') return null
  const s = o.research
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return s ? s.slice(0, 600) : null
}

/** The design brief in a build line, or null. */
export function toBuild(o: RawLine): string | null {
  if (typeof o.build !== 'string') return null
  const s = o.build.replace(/<[^>]*>/g, ' ').trim()
  return s ? s.slice(0, 4000) : null
}
