// A read-only SVG scene for hand-drawn diagrams: shapes with labels, text,
// frames (optionally holding a picture), arrows between shapes, and passing
// rings. Each item is one <g>, redrawn from its spec whenever the spec
// changes; there are a few dozen per page, so redrawing beats diffing.
//
// The caller decides what goes where and animates by setting specs frame by
// frame; the scene only draws. Arrows name the shapes they join and are
// redrawn when either one changes. People pan (drag, or scroll), zoom
// (pinch, or ctrl/cmd + scroll) and click links; nothing is editable.

import { arrowHead, arrowPath, arrowPoints, boundsOf, outline, translate, union } from './geometry'
import type { Pt, Rect } from './geometry'
import { animate, ease } from './anim'
import { wrap, zoomAt, type Camera } from './layout'
import { cloudPath, sketchy, smoothPath } from './wobble'

export interface Ink {
  stroke: string
  fill: string
}

interface Common {
  page: string
  opacity?: number
}

/** A shape with a centred label. A link makes it clickable. */
export interface ShapeSpec extends Common {
  kind: 'shape'
  x: number
  y: number
  w: number
  h: number
  geo: string
  color: string
  label: string
  link?: string
}

/** Free text, top-left at x, y. */
export interface TextSpec extends Common {
  kind: 'text'
  x: number
  y: number
  text: string
  color: string
  size: number
}

/** A labelled frame; `back` puts it behind everything, `image` fills it with a picture. */
export interface FrameSpec extends Common {
  kind: 'frame'
  x: number
  y: number
  w: number
  h: number
  label: string
  image?: string
  back?: boolean
}

/** An arrow between two shapes or frames (by id), drawn `progress` of the way. */
export interface ArrowSpec extends Common {
  kind: 'arrow'
  from: string
  to: string
  bend: number
  color: string
  dashed?: boolean
  label?: string
  progress?: number
}

/** A hand-drawn ring around an area; not part of the drawing's bounds. */
export interface RingSpec extends Common {
  kind: 'ring'
  x: number
  y: number
  w: number
  h: number
  color: string
}

export type Spec = ShapeSpec | TextSpec | FrameSpec | ArrowSpec | RingSpec

export interface SceneOptions {
  /** A linked shape was clicked (not dragged). */
  onLink?(link: string): void
  /** Colours by name; unknown names draw as `black`. */
  palette?: Record<string, Ink>
  /** Behind arrow labels, so the line stops short of the words. */
  background?: string
  /** Shape labels. */
  textColor?: string
}

type Layer = 'back' | 'main' | 'arrows' | 'top'
const LAYERS: Layer[] = ['back', 'main', 'arrows', 'top']

interface Item {
  spec: Spec
  g: SVGGElement
  /** What it covers on the page, once drawn. */
  bounds?: Rect
}

const NS = 'http://www.w3.org/2000/svg'
export const SKETCH_FONT = '"Shantell Sans", "Comic Sans MS", cursive'
const UI_FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif'
const LABEL_SIZE = 18
const ARROW_LABEL_SIZE = 16
const FRAME_LABEL_SIZE = 13
const LINE = 1.3
const MIN_ZOOM = 0.1
const MAX_ZOOM = 4

const ink = (hex: string): Ink => ({ stroke: hex, fill: `${hex}24` })

/** Colours for a dark background, under the names the board model uses. */
export const DARK_PALETTE: Record<string, Ink> = {
  black: ink('#e4e4ea'),
  grey: ink('#9aa0b4'),
  'light-violet': ink('#c9a8f5'),
  violet: ink('#a67ef2'),
  blue: ink('#5c8ff0'),
  'light-blue': ink('#64baf2'),
  yellow: ink('#f0c34e'),
  orange: ink('#f08c40'),
  green: ink('#41b87c'),
  'light-green': ink('#82d282'),
  'light-red': ink('#f28d8d'),
  red: ink('#e8494f'),
  white: ink('#f6f6f8')
}

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
  text?: string
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
  if (text !== undefined) node.textContent = text
  return node
}

export class SketchScene {
  readonly svg: SVGSVGElement
  private readonly view: SVGGElement
  private readonly pages = new Map<
    string,
    { root: SVGGElement; layers: Record<Layer, SVGGElement> }
  >()
  private readonly items = new Map<string, Item>()
  private current: string | null = null
  private cam: Camera = { x: 0, y: 0, z: 1 }
  private camRun = 0
  private readonly ctx: CanvasRenderingContext2D | null
  private readonly widths = new Map<string, number>()
  private readonly unlisten: (() => void)[] = []
  private destroyed = false

  constructor(
    private readonly host: HTMLElement,
    private readonly opts: SceneOptions = {}
  ) {
    this.svg = el('svg', { width: '100%', height: '100%', role: 'img' })
    this.svg.style.display = 'block'
    this.svg.style.touchAction = 'none'
    this.svg.style.userSelect = 'none'
    this.view = el('g', {})
    this.svg.append(this.view)
    host.append(this.svg)
    this.ctx = document.createElement('canvas').getContext('2d')
    this.listen()
    // Labels are measured in the sketch font; once it has loaded, measure again.
    void document.fonts
      ?.load(`${LABEL_SIZE}px ${SKETCH_FONT}`)
      .then(() => {
        if (this.destroyed) return
        this.widths.clear()
        for (const id of this.items.keys()) this.draw(id)
      })
      .catch(() => {})
  }

  destroy(): void {
    this.destroyed = true
    this.camRun++
    for (const off of this.unlisten.splice(0)) off()
    this.svg.remove()
  }

  // ---- pages

  get page(): string | null {
    return this.current
  }

  /** Make sure a page exists (it shows only once it's the current page). */
  ensurePage(id: string): void {
    if (this.pages.has(id)) return
    const root = el('g', { 'data-page': id })
    root.style.display = id === this.current ? '' : 'none'
    const layers = {} as Record<Layer, SVGGElement>
    for (const name of LAYERS) {
      layers[name] = el('g', { 'data-layer': name })
      root.append(layers[name])
    }
    this.view.append(root)
    this.pages.set(id, { root, layers })
  }

  showPage(id: string): void {
    this.ensurePage(id)
    this.current = id
    for (const [pid, p] of this.pages) p.root.style.display = pid === id ? '' : 'none'
  }

  removePage(id: string): void {
    for (const [itemId, item] of [...this.items]) if (item.spec.page === id) this.remove(itemId)
    this.pages.get(id)?.root.remove()
    this.pages.delete(id)
    if (this.current === id) this.current = null
  }

  pageIds(): string[] {
    return [...this.pages.keys()]
  }

  // ---- items

  has(id: string): boolean {
    return this.items.has(id)
  }

  spec(id: string): Spec | undefined {
    return this.items.get(id)?.spec
  }

  /** Add or replace an item; arrows attached to it follow. */
  set(id: string, spec: Spec): void {
    if (this.destroyed) return
    let item = this.items.get(id)
    if (item && item.spec.page !== spec.page) {
      this.remove(id)
      item = undefined
    }
    this.ensurePage(spec.page)
    const layer = this.pages.get(spec.page)!.layers[layerOf(spec)]
    if (!item) {
      const g = el('g', { 'data-id': id })
      layer.append(g)
      item = { spec, g }
      this.items.set(id, item)
    } else if (item.g.parentNode !== layer) {
      layer.append(item.g)
    }
    item.spec = spec
    this.draw(id)
    if (spec.kind === 'shape' || spec.kind === 'frame') this.drawArrowsAt(id)
  }

  setOpacity(id: string, opacity: number): void {
    const item = this.items.get(id)
    if (!item) return
    item.spec = { ...item.spec, opacity }
    item.g.style.opacity = String(opacity)
  }

  opacity(id: string): number {
    return this.items.get(id)?.spec.opacity ?? 1
  }

  remove(id: string): void {
    const item = this.items.get(id)
    if (!item) return
    item.g.remove()
    this.items.delete(id)
    this.drawArrowsAt(id)
  }

  /** Everything on the page, or null when it's empty. Rings don't count. */
  contentBounds(page = this.current): Rect | null {
    const rects: Rect[] = []
    for (const item of this.items.values()) {
      if (item.spec.page === page && item.spec.kind !== 'ring' && item.bounds)
        rects.push(item.bounds)
    }
    return union(rects)
  }

  // ---- camera

  get camera(): Camera {
    return { ...this.cam }
  }

  viewport(): { w: number; h: number } {
    return { w: this.host.clientWidth, h: this.host.clientHeight }
  }

  setCamera(cam: Camera): void {
    this.camRun++
    this.applyCamera(cam)
  }

  /** Glide the camera there; a newer move (or a person panning) cuts it short. */
  async moveCamera(to: Camera, ms: number): Promise<void> {
    if (ms <= 0) return this.setCamera(to)
    const run = ++this.camRun
    const from = this.cam
    await animate(ms, (p) => {
      if (run !== this.camRun || this.destroyed) return
      const e = ease(p)
      this.applyCamera({
        x: from.x + (to.x - from.x) * e,
        y: from.y + (to.y - from.y) * e,
        z: from.z + (to.z - from.z) * e
      })
    })
  }

  private applyCamera(cam: Camera): void {
    this.cam = cam
    this.view.setAttribute('transform', `scale(${cam.z}) translate(${cam.x} ${cam.y})`)
  }

  // ---- drawing

  private draw(id: string): void {
    const item = this.items.get(id)
    if (!item) return
    const { g, spec } = item
    g.replaceChildren()
    g.style.opacity = String(spec.opacity ?? 1)
    g.removeAttribute('transform')
    delete g.dataset.link
    g.style.cursor = ''
    item.bounds = undefined
    switch (spec.kind) {
      case 'shape':
        return this.drawShape(id, item, spec)
      case 'text':
        return this.drawText(item, spec)
      case 'frame':
        return this.drawFrame(item, spec)
      case 'arrow':
        return this.drawArrow(item, spec)
      case 'ring':
        return this.drawRing(id, item, spec)
    }
  }

  private drawArrowsAt(id: string): void {
    for (const [arrowId, item] of this.items) {
      if (item.spec.kind === 'arrow' && (item.spec.from === id || item.spec.to === id))
        this.draw(arrowId)
    }
  }

  private ink(color: string): Ink {
    const palette = this.opts.palette ?? DARK_PALETTE
    return palette[color] ?? palette.black ?? DARK_PALETTE.black
  }

  private measure(text: string, size: number, family = SKETCH_FONT): number {
    const key = `${size}|${family}|${text}`
    let w = this.widths.get(key)
    if (w === undefined) {
      if (this.ctx) {
        this.ctx.font = `${size}px ${family}`
        w = this.ctx.measureText(text).width
      } else {
        w = text.length * size * 0.55
      }
      this.widths.set(key, w)
    }
    return w
  }

  /** Lines of text centred on (cx, cy). */
  private textBlock(
    g: SVGGElement,
    lines: string[],
    cx: number,
    cy: number,
    size: number,
    fill: string,
    anchor: 'middle' | 'start' = 'middle'
  ): void {
    const lh = size * LINE
    const top = cy - (lines.length * lh) / 2
    lines.forEach((line, i) => {
      g.append(
        el(
          'text',
          {
            x: cx,
            y: top + lh * (i + 0.5),
            'text-anchor': anchor,
            'dominant-baseline': 'central',
            'font-family': SKETCH_FONT,
            'font-size': size,
            fill
          },
          line
        )
      )
    })
  }

  private drawShape(id: string, item: Item, s: ShapeSpec): void {
    const { g } = item
    const c = this.ink(s.color)
    g.setAttribute('transform', `translate(${s.x} ${s.y})`)
    const d = s.geo === 'cloud' ? cloudPath(s.w, s.h, id) : sketchy(outline(s.geo, s.w, s.h), id)
    g.append(
      el('path', {
        d,
        fill: c.fill,
        stroke: c.stroke,
        'stroke-width': 2,
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round'
      })
    )
    if (s.label) {
      const width = Math.max(40, s.w * labelShare(s.geo) - 24)
      const lines = wrap(s.label, width, (t) => this.measure(t, LABEL_SIZE))
      this.textBlock(g, lines, s.w / 2, s.h / 2, LABEL_SIZE, this.opts.textColor ?? '#ececf1')
    }
    if (s.link) {
      g.dataset.link = s.link
      g.style.cursor = 'pointer'
    }
    item.bounds = { x: s.x, y: s.y, w: s.w, h: s.h }
  }

  private drawText(item: Item, s: TextSpec): void {
    const lines = s.text.split('\n')
    const lh = s.size * LINE
    const c = this.ink(s.color)
    this.textBlock(item.g, lines, s.x, s.y + (lines.length * lh) / 2, s.size, c.stroke, 'start')
    const w = Math.max(0, ...lines.map((l) => this.measure(l, s.size)))
    item.bounds = { x: s.x, y: s.y, w, h: lines.length * lh }
  }

  private drawFrame(item: Item, s: FrameSpec): void {
    const { g } = item
    g.setAttribute('transform', `translate(${s.x} ${s.y})`)
    if (s.image) {
      g.append(
        el('image', {
          href: s.image,
          x: 0,
          y: 0,
          width: s.w,
          height: s.h,
          preserveAspectRatio: 'xMidYMin slice'
        })
      )
    }
    g.append(
      el('rect', {
        x: 0,
        y: 0,
        width: s.w,
        height: s.h,
        rx: 6,
        fill: s.image ? 'none' : 'rgba(255,255,255,0.025)',
        stroke: '#4c4c58',
        'stroke-width': 1.5
      })
    )
    if (s.label) {
      g.append(
        el(
          'text',
          { x: 2, y: -8, 'font-family': UI_FONT, 'font-size': FRAME_LABEL_SIZE, fill: '#9a9aa8' },
          s.label
        )
      )
    }
    item.bounds = { x: s.x, y: s.y - 24, w: s.w, h: s.h + 24 }
  }

  /** The outline (in page coordinates) of a shape or frame an arrow joins. */
  private endOf(id: string, page: string): { poly: Pt[] } | null {
    const spec = this.items.get(id)?.spec
    if (!spec || spec.page !== page) return null
    if (spec.kind === 'shape')
      return { poly: translate(outline(spec.geo, spec.w, spec.h), spec.x, spec.y) }
    if (spec.kind === 'frame')
      return { poly: translate(outline('rectangle', spec.w, spec.h), spec.x, spec.y) }
    return null
  }

  private drawArrow(item: Item, s: ArrowSpec): void {
    const from = this.endOf(s.from, s.page)
    const to = this.endOf(s.to, s.page)
    if (!from || !to) return
    const path = arrowPath(from, to, s.bend)
    if (!path) return
    const progress = s.progress ?? 1
    const pts = arrowPoints(path, progress)
    const c = this.ink(s.color)
    const line = {
      fill: 'none',
      stroke: c.stroke,
      'stroke-width': 2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round'
    }
    item.g.append(
      el('path', {
        d: smoothPath(pts, false),
        ...line,
        ...(s.dashed ? { 'stroke-dasharray': '8 7' } : {})
      })
    )
    const head = arrowHead(pts)
    if (head) item.g.append(el('path', { d: `M${head[0]}L${head[1]}L${head[2]}`, ...line }))
    const rects = [boundsOf(pts)]
    if (s.label && progress >= 1) {
      const [cx, cy] = path.at((path.t0 + path.t1) / 2)
      const lines = wrap(s.label, 160, (t) => this.measure(t, ARROW_LABEL_SIZE))
      const w = Math.max(...lines.map((l) => this.measure(l, ARROW_LABEL_SIZE))) + 12
      const h = lines.length * ARROW_LABEL_SIZE * LINE + 6
      const box = { x: cx - w / 2, y: cy - h / 2, w, h }
      item.g.append(
        el('rect', {
          x: box.x,
          y: box.y,
          width: w,
          height: h,
          rx: 4,
          fill: this.opts.background ?? '#101014'
        })
      )
      this.textBlock(item.g, lines, cx, cy, ARROW_LABEL_SIZE, c.stroke)
      rects.push(box)
    }
    item.bounds = union(rects) ?? undefined
  }

  private drawRing(id: string, item: Item, s: RingSpec): void {
    item.g.setAttribute('transform', `translate(${s.x} ${s.y})`)
    item.g.append(
      el('path', {
        d: sketchy(outline('ellipse', s.w, s.h), id, { roughness: 2.5, step: 40 }),
        fill: 'none',
        stroke: this.ink(s.color).stroke,
        'stroke-width': 3.5,
        'stroke-linecap': 'round'
      })
    )
  }

  // ---- input

  private listen(): void {
    const svg = this.svg
    let drag: { x: number; y: number; moved: number; target: Element | null } | null = null
    const on = <K extends keyof SVGSVGElementEventMap>(
      type: K,
      fn: (e: SVGSVGElementEventMap[K]) => void,
      opts?: AddEventListenerOptions
    ): void => {
      svg.addEventListener(type, fn, opts)
      this.unlisten.push(() => svg.removeEventListener(type, fn, opts))
    }
    on('pointerdown', (e) => {
      if (e.button !== 0) return
      drag = { x: e.clientX, y: e.clientY, moved: 0, target: e.target as Element | null }
      svg.setPointerCapture(e.pointerId)
    })
    on('pointermove', (e) => {
      if (!drag) return
      const dx = e.clientX - drag.x
      const dy = e.clientY - drag.y
      drag.moved += Math.hypot(dx, dy)
      drag.x = e.clientX
      drag.y = e.clientY
      if (drag.moved <= 4) return
      svg.style.cursor = 'grabbing'
      const cam = this.cam
      this.setCamera({ x: cam.x + dx / cam.z, y: cam.y + dy / cam.z, z: cam.z })
    })
    const end = (e: PointerEvent): void => {
      if (!drag) return
      // A drag pans; only a click opens a link.
      const link =
        drag.moved <= 4 ? drag.target?.closest('[data-link]')?.getAttribute('data-link') : null
      drag = null
      svg.style.cursor = ''
      if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId)
      if (link) this.opts.onLink?.(link)
    }
    on('pointerup', end)
    on('pointercancel', end)
    on(
      'wheel',
      (e) => {
        e.preventDefault()
        const cam = this.cam
        if (e.ctrlKey || e.metaKey) {
          // Pinch on a trackpad arrives as ctrl + wheel.
          const r = svg.getBoundingClientRect()
          // A mouse wheel's step is ~100 where a pinch's is a few; cap it so a click zooms gently.
          const step = Math.max(-25, Math.min(25, e.deltaY))
          const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, cam.z * Math.exp(-step * 0.01)))
          this.setCamera(zoomAt(cam, [e.clientX - r.left, e.clientY - r.top], z))
        } else {
          this.setCamera({ x: cam.x - e.deltaX / cam.z, y: cam.y - e.deltaY / cam.z, z: cam.z })
        }
      },
      { passive: false }
    )
  }
}

/** How much of a shape's width its label may use: pointed and round shapes have less room. */
function labelShare(geo: string): number {
  switch (geo) {
    case 'diamond':
    case 'triangle':
    case 'star':
      return 0.62
    case 'ellipse':
    case 'cloud':
    case 'hexagon':
    case 'octagon':
    case 'pentagon':
      return 0.8
    default:
      return 1
  }
}

function layerOf(spec: Spec): Layer {
  if (spec.kind === 'frame' && spec.back) return 'back'
  if (spec.kind === 'arrow') return 'arrows'
  if (spec.kind === 'ring') return 'top'
  return 'main'
}
