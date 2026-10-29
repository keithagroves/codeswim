// Draws the board model on a tldraw editor. The model (packages/whiteboard,
// board.ts) decides what goes where; this file only turns its effects into
// shapes and animates them: boxes fade in, text types itself on, arrows grow
// from start to end and then bind to their boxes, removed things fade out.
// Screenshots are a labelled frame holding the picture (loaded from disk when
// it isn't in memory), and a circle is a hand-drawn red ring that comes and
// goes on its own. Ported from the prototype's renderer
// (~/projects/anim/canvas/src/main.tsx).
//
// The editor is read-only for the person (they pan, zoom, flip pages and
// click links; they never draw). tldraw's readonly mode also blocks the API,
// so every write lifts it just for the duration of that write.

import {
  AssetRecordType,
  createShapeId,
  PageRecordType,
  toRichText,
  type Editor,
  type TLArrowBinding,
  type TLBindingCreate,
  type TLPageId,
  type TLShapeId
} from 'tldraw'
import type {
  BoardModel,
  Bounds,
  BoxEl,
  El,
  Effect,
  GroupEl,
  Page,
  ShotEl
} from '@codeswim/whiteboard'
import type { WhiteboardCanvas } from './controller'

type Pt = [number, number]

/** Screen space the overlays cover, so the drawing is kept clear of them. */
export interface Insets {
  left: number
  top: number
  right: number
  bottom: number
}

export const shapeIdFor = (elId: string): TLShapeId => createShapeId(elId)
export const pageIdFor = (page: string): TLPageId => PageRecordType.createId(page)

/**
 * Next animation step: an animation frame, or a timer if the window is hidden
 * (rAF pauses then). Progress comes from the wall clock, so a throttled
 * window still finishes on time.
 */
const frame = (): Promise<void> =>
  new Promise<void>((r) => {
    let done = false
    const go = (): void => {
      if (!done) {
        done = true
        r()
      }
    }
    requestAnimationFrame(go)
    setTimeout(go, 40)
  })
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const ease = (p: number): number => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2)

async function animate(ms: number, fn: (p: number) => void): Promise<void> {
  const start = performance.now()
  for (;;) {
    const p = Math.min(1, (performance.now() - start) / Math.max(1, ms))
    fn(p)
    if (p >= 1) return
    await frame()
  }
}

/** Where a ray from a box's centre towards `toward` leaves the box. */
function edgePoint(b: { x: number; y: number; w: number; h: number }, toward: Pt): Pt {
  const cx = b.x + b.w / 2
  const cy = b.y + b.h / 2
  const dx = toward[0] - cx
  const dy = toward[1] - cy
  const t = Math.min(b.w / 2 / (Math.abs(dx) || 1e-9), b.h / 2 / (Math.abs(dy) || 1e-9))
  return [cx + dx * Math.min(t, 1), cy + dy * Math.min(t, 1)]
}

const boxLabel = (el: BoxEl): string => (el.link ? `${el.label} ↗` : el.label)
/** The picture inside a screenshot's frame; a retaken picture gets a new one. */
const shotImageId = (el: ShotEl): TLShapeId => createShapeId(`${el.id}~img~${el.rev}`)
/** How long a circle takes to draw on and to fade away. */
const CIRCLE_IN_MS = 350
const CIRCLE_OUT_MS = 450

export class TldrawCanvas implements WhiteboardCanvas {
  private disposed = false

  constructor(
    private readonly editor: Editor,
    private readonly insets: () => Insets,
    /** A screenshot's picture by file name, as a URL (null if it's gone). */
    private readonly loadImage: (file: string) => Promise<string | null> = async () => null
  ) {}

  dispose(): void {
    this.disposed = true
  }

  /** Run editor writes with readonly lifted, kept out of the undo history. */
  private write(fn: () => void): void {
    if (this.disposed) return
    const editor = this.editor
    editor.updateInstanceState({ isReadonly: false })
    try {
      editor.run(fn, { history: 'ignore' })
    } finally {
      editor.updateInstanceState({ isReadonly: true })
    }
  }

  private exists(id: TLShapeId): boolean {
    return !this.disposed && !!this.editor.getShape(id)
  }

  // ---- full redraw (mount, workspace switch, new board)

  rebuild(board: BoardModel): void {
    const editor = this.editor
    const pages = board.pages
    const current = board.currentPage
    this.write(() => {
      for (const p of pages) this.ensurePage(p)
      editor.setCurrentPage(pageIdFor(current.id))
      const wanted = new Set(pages.map((p) => pageIdFor(p.id)))
      for (const p of editor.getPages()) {
        if (!wanted.has(p.id)) editor.deletePage(p.id)
      }
      for (const p of pages) {
        const ids = [...editor.getPageShapeIds(pageIdFor(p.id))]
        if (ids.length) editor.deleteShapes(ids)
      }
      for (const p of pages) {
        const els = board.elements(p.id)
        // Shapes first, then arrows (they bind to shapes), groups at the back.
        for (const el of els) if (el.kind !== 'arrow') this.create(el, el.opacity)
        for (const el of els) if (el.kind === 'arrow') this.createArrow(el, 1)
        const groups = els.filter((e) => e.kind === 'group').map((e) => shapeIdFor(e.id))
        if (groups.length) editor.sendToBack(groups)
      }
    })
    this.frameCamera(0)
  }

  private ensurePage(p: Page): void {
    const id = pageIdFor(p.id)
    const existing = this.editor.getPage(id)
    if (!existing) this.editor.createPage({ id, name: p.name || 'Untitled' })
    else if (existing.name !== (p.name || 'Untitled'))
      this.editor.renamePage(id, p.name || 'Untitled')
  }

  private create(el: Exclude<El, { kind: 'arrow' }>, opacity: number, text?: string): void {
    const id = shapeIdFor(el.id)
    const parentId = pageIdFor(el.page)
    if (el.kind === 'box') {
      this.editor.createShape({
        id,
        type: 'geo',
        parentId,
        x: el.x,
        y: el.y,
        opacity,
        meta: { elId: el.id, ...(el.link ? { link: el.link } : {}) },
        props: {
          geo: el.geo,
          w: el.w,
          h: el.h,
          color: el.color,
          fill: 'semi',
          dash: 'draw',
          size: 's',
          font: 'draw',
          richText: toRichText(text ?? boxLabel(el))
        }
      })
    } else if (el.kind === 'text') {
      this.editor.createShape({
        id,
        type: 'text',
        parentId,
        x: el.x,
        y: el.y,
        opacity,
        meta: { elId: el.id },
        props: {
          richText: toRichText(text ?? el.text),
          color: el.color,
          size: el.size,
          font: 'draw'
        }
      })
    } else {
      this.editor.createShape({
        id,
        type: 'frame',
        parentId,
        x: el.x,
        y: el.y,
        opacity,
        meta: { elId: el.id },
        props: { w: el.w, h: el.h, name: el.label }
      })
      if (el.kind === 'shot') void this.fillShot(el)
    }
  }

  /** Put a screenshot's picture into its frame, once it has loaded. */
  private async fillShot(el: ShotEl): Promise<void> {
    const src = await this.loadImage(el.image.file).catch(() => null)
    const frame = shapeIdFor(el.id)
    const imageId = shotImageId(el)
    if (!src || !this.exists(frame) || this.exists(imageId)) return
    const editor = this.editor
    const assetId = AssetRecordType.createId(el.image.file.replace(/\.jpg$/, ''))
    this.write(() => {
      // A retaken picture replaces the old one.
      const old = editor.getSortedChildIdsForParent(frame).filter((c) => c !== imageId)
      if (old.length) editor.deleteShapes(old)
      if (!editor.getAsset(assetId)) {
        editor.createAssets([
          {
            id: assetId,
            typeName: 'asset',
            type: 'image',
            meta: {},
            props: {
              name: el.image.file,
              src,
              w: el.image.width,
              h: el.image.height,
              mimeType: 'image/jpeg',
              isAnimated: false
            }
          }
        ])
      }
      editor.createShape({
        id: imageId,
        type: 'image',
        parentId: frame,
        x: 0,
        y: 0,
        meta: { elId: el.id },
        props: { assetId, w: el.w, h: el.h }
      })
    })
  }

  /** The page bounds of the shape an arrow end names (a box or a group on the arrow's page). */
  private endBounds(
    page: string,
    name: string
  ): { id: TLShapeId; b: { x: number; y: number; w: number; h: number } } | null {
    for (const kind of ['box', 'group', 'shot']) {
      const id = shapeIdFor(`${page}~${kind}~${name}`)
      const b = this.editor.getShapePageBounds(id)
      if (b) return { id, b: { x: b.x, y: b.y, w: b.w, h: b.h } }
    }
    return null
  }

  private createArrow(el: Extract<El, { kind: 'arrow' }>, progress: number): TLShapeId | null {
    const from = this.endBounds(el.page, el.from)
    const to = this.endBounds(el.page, el.to)
    if (!from || !to) return null
    const fromC: Pt = [from.b.x + from.b.w / 2, from.b.y + from.b.h / 2]
    const toC: Pt = [to.b.x + to.b.w / 2, to.b.y + to.b.h / 2]
    const a = edgePoint(from.b, toC)
    const b = edgePoint(to.b, fromC)
    const id = shapeIdFor(el.id)
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    this.editor.createShape({
      id,
      type: 'arrow',
      parentId: pageIdFor(el.page),
      x: a[0],
      y: a[1],
      opacity: el.opacity,
      meta: { elId: el.id },
      props: {
        start: { x: 0, y: 0 },
        end: { x: dx * progress || 0.1, y: dy * progress || 0.1 },
        bend: el.bend * progress,
        color: 'black',
        size: 's',
        dash: el.dashed ? 'dashed' : 'draw',
        richText: toRichText(progress >= 1 ? el.label : '')
      }
    })
    if (progress >= 1) this.bindArrow(id, from.id, to.id)
    return id
  }

  // Bound arrows stay attached if a box moves later.
  private bindArrow(id: TLShapeId, fromId: TLShapeId, toId: TLShapeId): void {
    const bind = (
      terminal: 'start' | 'end',
      target: TLShapeId
    ): TLBindingCreate<TLArrowBinding> => ({
      type: 'arrow' as const,
      fromId: id,
      toId: target,
      props: {
        terminal,
        normalizedAnchor: { x: 0.5, y: 0.5 },
        isExact: false,
        isPrecise: false,
        snap: 'none' as const
      }
    })
    this.editor.createBindings([bind('start', fromId), bind('end', toId)])
  }

  // ---- animated effects

  async render(effects: Effect[]): Promise<void> {
    for (const fx of effects) {
      if (this.disposed) return
      try {
        await this.play(fx)
      } catch (e) {
        // One bad shape mustn't stop the rest of the drawing.
        console.error('[whiteboard] drawing failed', fx, e)
      }
    }
  }

  private async play(fx: Effect): Promise<void> {
    const editor = this.editor
    switch (fx.fx) {
      case 'rename':
        this.write(() => this.ensurePage(fx.page))
        return
      case 'page': {
        const id = pageIdFor(fx.page.id)
        if (editor.getCurrentPageId() === id && editor.getPage(id)) return
        const canvas = document.querySelector<HTMLElement>('.whiteboard-canvas .tl-canvas')
        if (canvas) {
          canvas.style.transition = 'opacity 180ms'
          canvas.style.opacity = '0'
        }
        await sleep(180)
        this.write(() => {
          this.ensurePage(fx.page)
          editor.setCurrentPage(id)
        })
        this.frameCamera(0)
        if (canvas) canvas.style.opacity = '1'
        await sleep(180)
        return
      }
      case 'add':
        await this.add(fx.el, fx.ms)
        this.frameCamera(500)
        return
      case 'update':
        await this.update(fx.el, fx.ms)
        return
      case 'fade': {
        const ids = fx.ids.map(shapeIdFor).filter((id) => this.exists(id))
        const from = new Map(ids.map((id) => [id, editor.getShape(id)!.opacity]))
        await animate(fx.ms, (p) =>
          this.write(() =>
            editor.updateShapes(
              ids
                .filter((id) => this.exists(id))
                .map((id) => ({
                  id,
                  type: editor.getShape(id)!.type,
                  opacity: from.get(id)! + (fx.opacity - from.get(id)!) * ease(p)
                }))
            )
          )
        )
        return
      }
      case 'delete': {
        const ids = fx.ids.map(shapeIdFor).filter((id) => this.exists(id))
        if (!ids.length) return
        const from = new Map(ids.map((id) => [id, editor.getShape(id)!.opacity]))
        await animate(fx.ms, (p) =>
          this.write(() =>
            editor.updateShapes(
              ids
                .filter((id) => this.exists(id))
                .map((id) => ({
                  id,
                  type: editor.getShape(id)!.type,
                  opacity: from.get(id)! * (1 - ease(p))
                }))
            )
          )
        )
        this.write(() => editor.deleteShapes(ids.filter((id) => this.exists(id))))
        return
      }
      case 'circle':
        await this.circle(fx.page, fx.bounds, fx.ms)
        return
      case 'pulse': {
        const id = shapeIdFor(fx.id)
        if (!this.exists(id)) return
        const base = editor.getShape(id)!.opacity
        await animate(fx.ms, (p) => {
          if (!this.exists(id)) return
          this.write(() =>
            editor.updateShape({
              id,
              type: editor.getShape(id)!.type,
              opacity: base * (1 - 0.7 * Math.abs(Math.sin(p * Math.PI * 2)))
            })
          )
        })
        if (this.exists(id))
          this.write(() =>
            editor.updateShape({ id, type: editor.getShape(id)!.type, opacity: base })
          )
        return
      }
    }
  }

  private async add(el: El, ms: number): Promise<void> {
    const editor = this.editor
    const id = shapeIdFor(el.id)
    if (this.exists(id)) return
    if (el.kind === 'arrow') {
      // Arrows grow from start to end, then bind to their boxes.
      let created: TLShapeId | null = null
      this.write(() => {
        created = this.createArrow(el, 0)
      })
      if (!created) return
      const shape = editor.getShape(id)
      const end = this.arrowEnd(el)
      if (!shape || !end) return
      await animate(ms, (p) => {
        if (!this.exists(id)) return
        const e = ease(p)
        this.write(() =>
          editor.updateShape({
            id,
            type: 'arrow',
            props: { end: { x: end.dx * e || 0.1, y: end.dy * e || 0.1 }, bend: el.bend * e }
          })
        )
      })
      if (!this.exists(id)) return
      this.write(() => {
        this.bindArrow(id, end.fromId, end.toId)
        if (el.label)
          editor.updateShape({ id, type: 'arrow', props: { richText: toRichText(el.label) } })
      })
      return
    }
    if (el.kind === 'text') {
      // Text types itself on.
      this.write(() => this.create(el, el.opacity, ' '))
      let shown = -1
      await animate(ms, (p) => {
        const n = Math.round(p * el.text.length)
        if (n === shown || !this.exists(id)) return
        shown = n
        this.write(() =>
          editor.updateShape({
            id,
            type: 'text',
            props: { richText: toRichText(el.text.slice(0, n) || ' ') }
          })
        )
      })
      return
    }
    // Boxes and groups fade and settle in.
    this.write(() => {
      this.create(el, 0)
      if (el.kind === 'group') editor.sendToBack([id])
    })
    await animate(ms, (p) => {
      if (!this.exists(id)) return
      this.write(() =>
        editor.updateShape({ id, type: editor.getShape(id)!.type, opacity: el.opacity * ease(p) })
      )
    })
  }

  /**
   * A hand-drawn red ring around an area: it draws on, stays while the
   * sentence is spoken, then fades away by itself. Only the drawing-on is
   * waited for, so the next line isn't held up.
   */
  private async circle(page: string, b: Bounds, ms: number): Promise<void> {
    const editor = this.editor
    const id = createShapeId()
    const w = b.w * 1.15 + 36
    const h = b.h * 1.3 + 30
    const cx = b.x + b.w / 2
    const cy = b.y + b.h / 2
    const ring = (scale: number, opacity: number): void => {
      if (!this.exists(id)) return
      this.write(() =>
        editor.updateShape({
          id,
          type: 'geo',
          x: cx - (w * scale) / 2,
          y: cy - (h * scale) / 2,
          opacity,
          props: { w: w * scale, h: h * scale }
        })
      )
    }
    this.write(() =>
      editor.createShape({
        id,
        type: 'geo',
        parentId: pageIdFor(page),
        x: cx - w / 2,
        y: cy - h / 2,
        opacity: 0,
        props: {
          geo: 'ellipse',
          w,
          h,
          color: 'red',
          fill: 'none',
          dash: 'draw',
          size: 'm',
          font: 'draw',
          richText: toRichText('')
        }
      })
    )
    await animate(CIRCLE_IN_MS, (p) => ring(0.8 + 0.2 * ease(p), ease(p)))
    void (async () => {
      await sleep(Math.max(0, ms - CIRCLE_IN_MS - CIRCLE_OUT_MS))
      await animate(CIRCLE_OUT_MS, (p) => ring(1, 1 - ease(p)))
      if (this.exists(id)) this.write(() => editor.deleteShapes([id]))
    })()
  }

  private arrowEnd(
    el: Extract<El, { kind: 'arrow' }>
  ): { dx: number; dy: number; fromId: TLShapeId; toId: TLShapeId } | null {
    const from = this.endBounds(el.page, el.from)
    const to = this.endBounds(el.page, el.to)
    if (!from || !to) return null
    const fromC: Pt = [from.b.x + from.b.w / 2, from.b.y + from.b.h / 2]
    const toC: Pt = [to.b.x + to.b.w / 2, to.b.y + to.b.h / 2]
    const a = edgePoint(from.b, toC)
    const b = edgePoint(to.b, fromC)
    return { dx: b[0] - a[0], dy: b[1] - a[1], fromId: from.id, toId: to.id }
  }

  private async update(el: El, ms: number): Promise<void> {
    const editor = this.editor
    const id = shapeIdFor(el.id)
    const shape = editor.getShape(id)
    if (!shape) return
    if (el.kind === 'box' || el.kind === 'group' || el.kind === 'shot') {
      const target = el as BoxEl | GroupEl | ShotEl
      if (el.kind === 'shot') void this.fillShot(el)
      const props =
        el.kind === 'box'
          ? { color: el.color, richText: toRichText(boxLabel(el)) }
          : { name: (el as GroupEl | ShotEl).label }
      this.write(() =>
        editor.updateShape({
          id,
          type: shape.type,
          opacity: el.opacity,
          meta: { ...shape.meta, ...(el.kind === 'box' && el.link ? { link: el.link } : {}) },
          props
        } as never)
      )
      const x0 = shape.x
      const y0 = shape.y
      if (x0 === target.x && y0 === target.y) return
      await animate(ms, (p) => {
        if (!this.exists(id)) return
        const e = ease(p)
        this.write(() =>
          editor.updateShape({
            id,
            type: shape.type,
            x: x0 + (target.x - x0) * e,
            y: y0 + (target.y - y0) * e
          })
        )
      })
      this.frameCamera(400)
    }
  }

  // ---- camera

  /**
   * Keep the drawing in the uncovered part of the screen as it grows, without
   * zooming in past 100%. An empty page starts at a friendly offset.
   */
  frameCamera(ms = 500): void {
    if (this.disposed) return
    const editor = this.editor
    const cover = this.insets()
    const all = editor.getCurrentPageBounds()
    if (!all) {
      editor.setCamera({ x: cover.left + 60, y: cover.top + 200, z: 1 })
      return
    }
    const s = editor.getViewportScreenBounds()
    const z = editor.getZoomLevel()
    const cam = editor.getCamera()
    const m = 40
    const toPage = (x: number, y: number): { x: number; y: number } => ({
      x: x / z - cam.x,
      y: y / z - cam.y
    })
    const a = toPage(cover.left + m, cover.top + m)
    const b = toPage(s.w - cover.right - m, s.h - cover.bottom - m)
    if (all.minX >= a.x && all.minY >= a.y && all.maxX <= b.x && all.maxY <= b.y) return
    const fw = Math.max(100, s.w - cover.left - cover.right - 2 * m)
    const fh = Math.max(100, s.h - cover.top - cover.bottom - 2 * m)
    const nz = Math.max(0.1, Math.min(1, fw / all.w, fh / all.h))
    const cx = cover.left + m + fw / 2
    const cy = cover.top + m + fh / 2
    editor.setCamera(
      { x: cx / nz - all.midX, y: cy / nz - all.midY, z: nz },
      ms ? { animation: { duration: ms } } : undefined
    )
  }
}
