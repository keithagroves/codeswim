// Shape outlines and arrow geometry, in plain numbers (no DOM), so it's
// tested in Node.
//
// An arrow runs along a curve from the centre of one shape to the centre of
// the other and is cut where it leaves the first outline and where it meets
// the second, so it touches the visible edge of an ellipse or a diamond, not
// its bounding box. A bend is the distance the curve's middle is pushed off
// the straight line, on the side tldraw used (to the right, walking from the
// start), so the bends the board model picks curve the way they always have.

export type Pt = [number, number]

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const TAU = Math.PI * 2

/** Points around an ellipse filling a w × h box. */
export function ellipse(w: number, h: number, n = 48): Pt[] {
  const pts: Pt[] = []
  for (let i = 0; i < n; i++) {
    const a = (TAU * i) / n
    pts.push([w / 2 + (w / 2) * Math.cos(a), h / 2 + (h / 2) * Math.sin(a)])
  }
  return pts
}

/** Stretch points so their bounding box is exactly w × h. */
function fit(pts: Pt[], w: number, h: number): Pt[] {
  const b = boundsOf(pts)
  return pts.map(([x, y]) => [((x - b.x) / (b.w || 1)) * w, ((y - b.y) / (b.h || 1)) * h])
}

function regular(n: number, w: number, h: number, rotation: number, inner?: number): Pt[] {
  const pts: Pt[] = []
  const count = inner === undefined ? n : n * 2
  for (let i = 0; i < count; i++) {
    const a = rotation + (TAU * i) / count
    const r = inner !== undefined && i % 2 ? inner : 1
    pts.push([Math.cos(a) * r, Math.sin(a) * r])
  }
  return fit(pts, w, h)
}

/** A shape's outline as a closed polygon, in its own w × h box. Unknown shapes are rectangles. */
export function outline(geo: string, w: number, h: number): Pt[] {
  switch (geo) {
    case 'ellipse':
    case 'cloud':
      return ellipse(w, h)
    case 'oval': {
      // A stadium: straight sides, round ends on the short axis.
      const r = Math.min(w, h) / 2
      const pts: Pt[] = []
      const arc = (cx: number, cy: number, from: number): void => {
        for (let i = 0; i <= 12; i++) {
          const a = from + (Math.PI * i) / 12
          pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
        }
      }
      if (w >= h) {
        arc(w - r, r, -Math.PI / 2)
        arc(r, r, Math.PI / 2)
      } else {
        arc(r, h - r, 0)
        arc(r, r, Math.PI)
      }
      return pts
    }
    case 'diamond':
      return [
        [w / 2, 0],
        [w, h / 2],
        [w / 2, h],
        [0, h / 2]
      ]
    case 'rhombus': {
      const o = Math.min(w * 0.25, h)
      return [
        [o, 0],
        [w, 0],
        [w - o, h],
        [0, h]
      ]
    }
    case 'triangle':
      return [
        [w / 2, 0],
        [w, h],
        [0, h]
      ]
    case 'trapezoid': {
      const o = Math.min(w * 0.2, h)
      return [
        [o, 0],
        [w - o, 0],
        [w, h],
        [0, h]
      ]
    }
    case 'hexagon': {
      const o = Math.min(w * 0.25, h * 0.5)
      return [
        [o, 0],
        [w - o, 0],
        [w, h / 2],
        [w - o, h],
        [o, h],
        [0, h / 2]
      ]
    }
    case 'pentagon':
      return regular(5, w, h, -Math.PI / 2)
    case 'octagon':
      return regular(8, w, h, Math.PI / 8)
    case 'star':
      return regular(5, w, h, -Math.PI / 2, 0.45)
    default:
      return [
        [0, 0],
        [w, 0],
        [w, h],
        [0, h]
      ]
  }
}

export function translate(pts: Pt[], dx: number, dy: number): Pt[] {
  return pts.map(([x, y]) => [x + dx, y + dy])
}

/** Is p inside the closed polygon? (Even-odd rule.) */
export function inside(poly: Pt[], p: Pt): boolean {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

export function boundsOf(pts: Pt[]): Rect {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of pts) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export function union(rects: Rect[]): Rect | null {
  if (!rects.length) return null
  return boundsOf(rects.flatMap((r) => [[r.x, r.y] as Pt, [r.x + r.w, r.y + r.h] as Pt]))
}

/** A curve from a to b, as a point for each t in [0, 1]: a straight line, or a circular arc. */
export function curve(a: Pt, b: Pt, bend: number): (t: number) => Pt {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy)
  const line = (t: number): Pt => [a[0] + dx * t, a[1] + dy * t]
  if (Math.abs(bend) < 0.5 || len < 1) return line
  // The arc passes through the middle, pushed `bend` to the right of a → b.
  const h: Pt = [(a[0] + b[0]) / 2 + (dy / len) * bend, (a[1] + b[1]) / 2 - (dx / len) * bend]
  const c = circumcentre(a, h, b)
  if (!c) return line
  const r = Math.hypot(a[0] - c[0], a[1] - c[1])
  const angle = (p: Pt): number => Math.atan2(p[1] - c[1], p[0] - c[0])
  const mod = (v: number): number => ((v % TAU) + TAU) % TAU
  const start = angle(a)
  const toEnd = mod(angle(b) - start)
  const toMid = mod(angle(h) - start)
  // Go the way round that passes through the pushed middle.
  const sweep = toMid < toEnd ? toEnd : toEnd - TAU
  return (t) => [c[0] + r * Math.cos(start + sweep * t), c[1] + r * Math.sin(start + sweep * t)]
}

function circumcentre(a: Pt, b: Pt, c: Pt): Pt | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]))
  if (Math.abs(d) < 1e-9) return null
  const a2 = a[0] ** 2 + a[1] ** 2
  const b2 = b[0] ** 2 + b[1] ** 2
  const c2 = c[0] ** 2 + c[1] ** 2
  return [
    (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d,
    (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d
  ]
}

/** An arrow's visible stretch of its curve: from t0 (leaving its start) to t1 (reaching its end). */
export interface ArrowPath {
  at: (t: number) => Pt
  t0: number
  t1: number
}

/** A shape an arrow joins: its outline in page coordinates. */
export interface End {
  poly: Pt[]
}

const STEPS = 160

/**
 * The arrow from one shape to another along a curve between their centres,
 * cut at both outlines and pulled back `gap` from each. Null when the shapes
 * overlap so much that nothing of the arrow would show.
 */
export function arrowPath(from: End, to: End, bend: number, gap = 6): ArrowPath | null {
  const a = centreOf(from.poly)
  const b = centreOf(to.poly)
  const at = curve(a, b, bend)
  // Last t still inside the start shape, and first t inside the end shape.
  let t0 = 0
  for (let i = 1; i <= STEPS && inside(from.poly, at(i / STEPS)); i++) t0 = i / STEPS
  let t1 = 1
  for (let i = STEPS - 1; i >= 0 && inside(to.poly, at(i / STEPS)); i--) t1 = i / STEPS
  t0 = refine(at, from.poly, t0, t0 + 1 / STEPS)
  t1 = refine(at, to.poly, t1, t1 - 1 / STEPS)
  const length = arcLength(at, t0, t1)
  if (t1 <= t0 || length <= gap * 2 + 4) return null
  const dt = (gap / length) * (t1 - t0)
  return { at, t0: t0 + dt, t1: t1 - dt }
}

/** Bisect between a t inside the polygon and a t outside it, to the crossing. */
function refine(at: (t: number) => Pt, poly: Pt[], tIn: number, tOut: number): number {
  if (!inside(poly, at(tIn))) return tIn
  for (let i = 0; i < 20; i++) {
    const mid = (tIn + tOut) / 2
    if (inside(poly, at(mid))) tIn = mid
    else tOut = mid
  }
  return tOut
}

function arcLength(at: (t: number) => Pt, t0: number, t1: number, n = 24): number {
  let len = 0
  let prev = at(t0)
  for (let i = 1; i <= n; i++) {
    const p = at(t0 + ((t1 - t0) * i) / n)
    len += Math.hypot(p[0] - prev[0], p[1] - prev[1])
    prev = p
  }
  return len
}

/** Points along the arrow, from its start to `progress` of the way to its end. */
export function arrowPoints(path: ArrowPath, progress = 1, spacing = 8): Pt[] {
  const end = path.t0 + (path.t1 - path.t0) * Math.max(0, Math.min(1, progress))
  const n = Math.max(2, Math.ceil(arcLength(path.at, path.t0, end) / spacing))
  const pts: Pt[] = []
  for (let i = 0; i <= n; i++) pts.push(path.at(path.t0 + ((end - path.t0) * i) / n))
  return pts
}

/** The two short strokes of an arrowhead at the last point, pointing along the line. */
export function arrowHead(pts: Pt[], size = 13): [Pt, Pt, Pt] | null {
  if (pts.length < 2) return null
  const tip = pts[pts.length - 1]
  // A point a little way back gives a steadier direction than the last step.
  let back = pts[pts.length - 2]
  for (let i = pts.length - 2; i >= 0; i--) {
    back = pts[i]
    if (Math.hypot(tip[0] - back[0], tip[1] - back[1]) >= size) break
  }
  const angle = Math.atan2(tip[1] - back[1], tip[0] - back[0])
  const wing = (s: number): Pt => [
    tip[0] - size * Math.cos(angle + s * 0.45),
    tip[1] - size * Math.sin(angle + s * 0.45)
  ]
  return [wing(1), tip, wing(-1)]
}

export function centreOf(pts: Pt[]): Pt {
  const b = boundsOf(pts)
  return [b.x + b.w / 2, b.y + b.h / 2]
}
