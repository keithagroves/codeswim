import { describe, expect, it } from 'vitest'
import {
  arrowHead,
  arrowPath,
  arrowPoints,
  boundsOf,
  curve,
  inside,
  outline,
  translate,
  type Pt
} from './geometry'

const GEOS = [
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
  'rhombus',
  'something-new'
]

const near = (a: Pt, b: Pt, d = 0.5): boolean => Math.hypot(a[0] - b[0], a[1] - b[1]) <= d
const box = (geo: string, x: number, y: number, w = 200, h = 90): { poly: Pt[] } => ({
  poly: translate(outline(geo, w, h), x, y)
})

describe('outline', () => {
  it.each(GEOS)('%s fills its box exactly', (geo) => {
    const b = boundsOf(outline(geo, 200, 90))
    expect(b.x).toBeCloseTo(0, 5)
    expect(b.y).toBeCloseTo(0, 5)
    expect(b.w).toBeCloseTo(200, 5)
    expect(b.h).toBeCloseTo(90, 5)
  })

  it('contains its own centre', () => {
    for (const geo of GEOS) expect(inside(outline(geo, 200, 90), [100, 45])).toBe(true)
  })

  it('leaves out the corners of round and pointed shapes', () => {
    for (const geo of ['ellipse', 'diamond', 'hexagon', 'oval', 'star'])
      expect(inside(outline(geo, 200, 90), [3, 3])).toBe(false)
    expect(inside(outline('rectangle', 200, 90), [3, 3])).toBe(true)
  })
})

describe('curve', () => {
  it('is a straight line without a bend', () => {
    const at = curve([0, 0], [100, 0], 0)
    expect(at(0.5)).toEqual([50, 0])
  })

  it('passes through both ends and bulges by the bend, to the right of the way it runs', () => {
    const at = curve([0, 0], [200, 0], 60)
    expect(near(at(0), [0, 0])).toBe(true)
    expect(near(at(1), [200, 0])).toBe(true)
    // Walking from (0,0) to (200,0) on screen (y down), the right-hand side is -y.
    expect(near(at(0.5), [100, -60], 1)).toBe(true)
    expect(near(curve([0, 0], [200, 0], -60)(0.5), [100, 60], 1)).toBe(true)
  })
})

describe('arrowPath', () => {
  it('runs between the facing edges of two boxes, a small gap short of each', () => {
    const path = arrowPath(box('rectangle', 0, 0), box('rectangle', 380, 0), 0)!
    const [sx, sy] = path.at(path.t0)
    const [ex, ey] = path.at(path.t1)
    expect(sx).toBeCloseTo(206, 0)
    expect(sy).toBeCloseTo(45, 5)
    expect(ex).toBeCloseTo(374, 0)
    expect(ey).toBeCloseTo(45, 5)
  })

  it('meets an ellipse at its curve, not its bounding box', () => {
    // Diagonal: the ellipse's edge sits well inside the box's corner.
    const path = arrowPath(box('rectangle', 0, 0), box('ellipse', 380, 220), 0, 0)!
    const end = path.at(path.t1)
    const ellipse = box('ellipse', 380, 220).poly
    const rect = box('rectangle', 380, 220).poly
    expect(inside(rect, [end[0] + 3, end[1] + 3])).toBe(true)
    expect(inside(ellipse, [end[0] - 3, end[1] - 3])).toBe(false)
  })

  it('keeps its bend after clipping', () => {
    const path = arrowPath(box('rectangle', 0, 0), box('rectangle', 760, 0), 120)!
    const mid = path.at((path.t0 + path.t1) / 2)
    expect(mid[1]).toBeLessThan(45 - 60)
  })

  it('is null when the shapes overlap', () => {
    expect(arrowPath(box('rectangle', 0, 0), box('rectangle', 20, 10), 0)).toBeNull()
  })
})

describe('arrowPoints and arrowHead', () => {
  const path = arrowPath(box('rectangle', 0, 0), box('rectangle', 380, 0), 0)!

  it('grows from the start', () => {
    const half = arrowPoints(path, 0.5)
    const full = arrowPoints(path)
    expect(half[0]).toEqual(full[0])
    expect(half.at(-1)![0]).toBeCloseTo((206 + 374) / 2, 0)
    expect(full.at(-1)![0]).toBeCloseTo(374, 0)
  })

  it('points the head back along the line', () => {
    const [a, tip, b] = arrowHead(arrowPoints(path))!
    expect(tip[0]).toBeCloseTo(374, 0)
    expect(a[0]).toBeLessThan(tip[0])
    expect(b[0]).toBeLessThan(tip[0])
    expect(a[1]).not.toBeCloseTo(b[1], 1)
  })
})
