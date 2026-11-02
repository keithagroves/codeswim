// The hand-drawn look: outlines are resampled, nudged by a little seeded
// noise, and drawn as one smooth curve through the nudged points. The seed is
// the shape's id, so a shape keeps the same wobble every time it's redrawn
// (while it moves, grows or changes colour) instead of shimmering.

import type { Pt } from './geometry'

/** A repeatable random number generator in [0, 1) for a seed string. */
export function seeded(seed: string): () => number {
  // FNV-1a for the string, then mulberry32.
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  let s = h >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Points along a polyline (or closed polygon) no more than `step` apart, corners kept. */
export function resample(pts: Pt[], closed: boolean, step: number): Pt[] {
  const out: Pt[] = []
  const n = closed ? pts.length : pts.length - 1
  for (let i = 0; i < n; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    const k = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step))
    for (let j = 0; j < k; j++)
      out.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k])
  }
  if (!closed) out.push(pts[pts.length - 1])
  return out
}

const f = (v: number): string => (Math.round(v * 10) / 10).toString()

/** A smooth SVG path through the points (Catmull-Rom as cubic Béziers). */
export function smoothPath(pts: Pt[], closed: boolean): string {
  if (pts.length < 2) return ''
  if (pts.length === 2) return `M${f(pts[0][0])} ${f(pts[0][1])}L${f(pts[1][0])} ${f(pts[1][1])}`
  const n = pts.length
  const get = (i: number): Pt =>
    closed ? pts[((i % n) + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`
  const last = closed ? n : n - 1
  for (let i = 0; i < last; i++) {
    const p0 = get(i - 1)
    const p1 = get(i)
    const p2 = get(i + 1)
    const p3 = get(i + 2)
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`
  }
  return closed ? d + 'Z' : d
}

/** A hand-drawn path along the outline. `roughness` is how far (px) a point may stray. */
export function sketchy(
  pts: Pt[],
  seed: string,
  opts: { closed?: boolean; roughness?: number; step?: number } = {}
): string {
  const closed = opts.closed ?? true
  const roughness = opts.roughness ?? 1.4
  const rand = seeded(seed)
  const wobbly = resample(pts, closed, opts.step ?? 28).map(([x, y]): Pt => [
    x + (rand() - 0.5) * 2 * roughness,
    y + (rand() - 0.5) * 2 * roughness
  ])
  return smoothPath(wobbly, closed)
}

/** A cloud filling a w × h box: bumps around an ellipse, each a little different. */
export function cloudPath(w: number, h: number, seed: string): string {
  const rand = seeded(seed)
  const perimeter = Math.PI * (w + h) * 0.5
  const n = Math.max(7, Math.round(perimeter / 55))
  // The bumps bulge outwards, so their base ellipse sits inside the box.
  const inset = Math.min(w, h) * 0.12
  const rx = w / 2 - inset
  const ry = h / 2 - inset
  const pts: Pt[] = []
  for (let i = 0; i < n; i++) {
    const a = ((i + (rand() - 0.5) * 0.3) / n) * Math.PI * 2
    pts.push([w / 2 + rx * Math.cos(a), h / 2 + ry * Math.sin(a)])
  }
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`
  for (let i = 0; i < n; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % n]
    const mid: Pt = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]
    // Push the control point away from the centre, scaled to the bump's width.
    const out: Pt = [mid[0] - w / 2, mid[1] - h / 2]
    const len = Math.hypot(out[0], out[1]) || 1
    const bulge = Math.hypot(q[0] - p[0], q[1] - p[1]) * (0.55 + rand() * 0.2)
    const c: Pt = [mid[0] + (out[0] / len) * bulge, mid[1] + (out[1] / len) * bulge]
    d += `Q${f(c[0])} ${f(c[1])} ${f(q[0])} ${f(q[1])}`
  }
  return d + 'Z'
}
