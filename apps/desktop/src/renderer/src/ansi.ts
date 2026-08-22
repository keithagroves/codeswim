// Minimal ANSI parser for the script-output terminal. Turns a raw stream
// (with SGR colour codes, cursor/erase control sequences, and carriage
// returns) into lines of styled segments the renderer can paint as spans.
//
// We deliberately don't pull in a terminal emulator (xterm) — the script
// runner pipes stdout, it isn't a PTY, so there's no full cursor grid to
// emulate. We handle the cases that actually show up in dev-server output:
// SGR styling, `\r` line rewrites (spinners), and stray CSI sequences that
// would otherwise render as garbage.

export interface AnsiSegment {
  text: string
  // Resolved CSS colour strings (or undefined for the terminal default).
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

// Terminal defaults, matching the .script-output-body theme.
const DEFAULT_FG = '#e6edf3'
const DEFAULT_BG = '#0d1117'

// 16-colour palette tuned to the GitHub-dark background. Index 0-7 normal,
// 8-15 bright.
const PALETTE = [
  '#484f58', // black
  '#ff7b72', // red
  '#3fb950', // green
  '#d29922', // yellow
  '#58a6ff', // blue
  '#bc8cff', // magenta
  '#39c5cf', // cyan
  '#b1bac4', // white
  '#6e7681', // bright black
  '#ffa198', // bright red
  '#56d364', // bright green
  '#e3b341', // bright yellow
  '#79c0ff', // bright blue
  '#d2a8ff', // bright magenta
  '#56d4dd', // bright cyan
  '#f0f6fc' // bright white
]

interface Style {
  fg?: string
  bg?: string
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
  inverse: boolean
}

function freshStyle(): Style {
  return { bold: false, dim: false, italic: false, underline: false, inverse: false }
}

// xterm 256-colour cube → hex. 0-15 palette, 16-231 6×6×6 cube, 232-255 gray.
function xterm256(n: number): string {
  if (n < 16) return PALETTE[n]
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return rgb(v, v, v)
  }
  const i = n - 16
  const r = Math.floor(i / 36)
  const g = Math.floor((i % 36) / 6)
  const b = i % 6
  const c = (x: number): number => (x === 0 ? 0 : 55 + x * 40)
  return rgb(c(r), c(g), c(b))
}

function rgb(r: number, g: number, b: number): string {
  return `rgb(${r}, ${g}, ${b})`
}

// Apply one SGR sequence's numeric codes to the running style. Returns the
// mutated style (in place).
function applySgr(style: Style, codes: number[]): void {
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]
    switch (true) {
      case code === 0:
        Object.assign(style, freshStyle())
        break
      case code === 1:
        style.bold = true
        break
      case code === 2:
        style.dim = true
        break
      case code === 3:
        style.italic = true
        break
      case code === 4:
        style.underline = true
        break
      case code === 7:
        style.inverse = true
        break
      case code === 22:
        style.bold = false
        style.dim = false
        break
      case code === 23:
        style.italic = false
        break
      case code === 24:
        style.underline = false
        break
      case code === 27:
        style.inverse = false
        break
      case code >= 30 && code <= 37:
        style.fg = PALETTE[code - 30]
        break
      case code >= 90 && code <= 97:
        style.fg = PALETTE[code - 90 + 8]
        break
      case code === 39:
        style.fg = undefined
        break
      case code >= 40 && code <= 47:
        style.bg = PALETTE[code - 40]
        break
      case code >= 100 && code <= 107:
        style.bg = PALETTE[code - 100 + 8]
        break
      case code === 49:
        style.bg = undefined
        break
      case code === 38 || code === 48: {
        // Extended colour: 38;5;n / 38;2;r;g;b (or 48;… for background).
        const target: 'fg' | 'bg' = code === 38 ? 'fg' : 'bg'
        const mode = codes[i + 1]
        if (mode === 5) {
          const n = codes[i + 2]
          if (n !== undefined) style[target] = xterm256(n)
          i += 2
        } else if (mode === 2) {
          const [r, g, b] = [codes[i + 2], codes[i + 3], codes[i + 4]]
          if (r !== undefined && g !== undefined && b !== undefined) {
            style[target] = rgb(r, g, b)
          }
          i += 4
        }
        break
      }
      default:
        // Unknown SGR code — ignore.
        break
    }
  }
}

function segmentFor(text: string, style: Style): AnsiSegment {
  // Resolve inverse by swapping fg/bg against the terminal defaults.
  const fg = style.inverse ? (style.bg ?? DEFAULT_BG) : style.fg
  const bg = style.inverse ? (style.fg ?? DEFAULT_FG) : style.bg
  return {
    text,
    fg,
    bg,
    bold: style.bold || undefined,
    dim: style.dim || undefined,
    italic: style.italic || undefined,
    underline: style.underline || undefined
  }
}

const ESC = '\u001b'

export function parseAnsi(input: string): AnsiSegment[][] {
  const lines: AnsiSegment[][] = []
  let line: AnsiSegment[] = []
  let buf = ''
  const style = freshStyle()

  const flush = (): void => {
    if (buf.length === 0) return
    line.push(segmentFor(buf, style))
    buf = ''
  }

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]

    if (ch === ESC && input[i + 1] === '[') {
      flush()
      // Read the CSI sequence: params until a final byte in @–~ (0x40-0x7e).
      let j = i + 2
      let params = ''
      while (j < input.length) {
        const c = input[j]
        if (c >= '@' && c <= '~') break
        params += c
        j++
      }
      const final = input[j]
      if (final === 'm') {
        const codes = params === '' ? [0] : params.split(';').map((p) => Number(p) || 0)
        applySgr(style, codes)
      }
      // Any other final byte (K erase, A/B/C/D cursor, J clear, H home, …)
      // we simply drop — there's no grid to act on.
      i = j
      continue
    }

    if (ch === '\n') {
      flush()
      lines.push(line)
      line = []
      continue
    }

    if (ch === '\r') {
      // CR not followed by LF rewinds to column 0; emulate by discarding the
      // current line so the next write (spinner frame) replaces it.
      if (input[i + 1] !== '\n') {
        buf = ''
        line = []
      }
      continue
    }

    buf += ch
  }

  flush()
  lines.push(line)
  return lines
}

// Plain-text lines (styling discarded) — for contexts that need the text
// content, not a renderable representation, e.g. the ScreenContextV2
// script-output block published for the agent.
export function stripAnsiToPlainLines(input: string): string[] {
  return parseAnsi(input).map((segments) => segments.map((s) => s.text).join(''))
}

// Keeps the most recent lines, bounded by both a line count and a total byte
// size — a single very long line (an unbroken progress bar, say) shouldn't
// blow the byte budget just because it's "one line". Always keeps at least
// the last line, even if it alone exceeds maxBytes.
export function boundedTail(lines: string[], maxLines: number, maxBytes: number): string[] {
  const recent = lines.slice(-maxLines)
  const out: string[] = []
  let bytes = 0
  for (let i = recent.length - 1; i >= 0; i--) {
    const lineBytes = new TextEncoder().encode(recent[i]).length
    if (bytes + lineBytes > maxBytes && out.length > 0) break
    out.unshift(recent[i])
    bytes += lineBytes
  }
  return out
}
