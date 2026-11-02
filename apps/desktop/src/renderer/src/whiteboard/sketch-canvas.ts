// Draws the board model on an SVG sketch scene (@codeswim/sketch). The model
// (packages/whiteboard, board.ts) decides what goes where; this file only
// turns its effects into scene items and animates them: boxes fade in, text
// types itself on, arrows grow from start to end, removed things fade out.
// Screenshots are a labelled frame holding the picture (loaded from disk when
// it isn't in memory), and a circle is a hand-drawn red ring that comes and
// goes on its own.
//
// The scene is read-only for the person: they pan, zoom, flip pages and click
// links; they never draw.

import {
  animate,
  ease,
  fitCamera,
  sleep,
  type Insets,
  type SketchScene,
  type Spec
} from '@codeswim/sketch'
import type { BoardModel, Bounds, BoxEl, El, Effect, ShotEl } from '@codeswim/whiteboard'
import type { WhiteboardCanvas } from './controller'

export type { Insets }

const boxLabel = (el: BoxEl): string => (el.link ? `${el.label} ↗` : el.label)
/** How long a circle takes to draw on and to fade away. */
const CIRCLE_IN_MS = 350
const CIRCLE_OUT_MS = 450
const TEXT_SIZE = { s: 18, l: 36 } as const

export class SketchCanvas implements WhiteboardCanvas {
  private disposed = false
  /** Pictures loaded into screenshot frames: element id → the rev shown. */
  private readonly shown = new Map<string, number>()
  private rings = 0

  constructor(
    private readonly scene: SketchScene,
    private readonly insets: () => Insets,
    /** A screenshot's picture by file name, as a URL (null if it's gone). */
    private readonly loadImage: (file: string) => Promise<string | null> = async () => null
  ) {}

  dispose(): void {
    this.disposed = true
  }

  private exists(id: string): boolean {
    return !this.disposed && this.scene.has(id)
  }

  // ---- full redraw (mount, workspace switch, new board)

  rebuild(board: BoardModel): void {
    if (this.disposed) return
    const scene = this.scene
    for (const id of scene.pageIds()) scene.removePage(id)
    this.shown.clear()
    for (const p of board.pages) scene.ensurePage(p.id)
    scene.showPage(board.currentPage.id)
    for (const p of board.pages) {
      const els = board.elements(p.id)
      // Shapes first, then the arrows that join them.
      for (const el of els) if (el.kind !== 'arrow') this.put(el)
      for (const el of els) if (el.kind === 'arrow') this.put(el)
    }
    this.frameCamera(0)
  }

  /** The scene item for an element; text may be cut short (typing on), an arrow drawn part way. */
  private specFor(el: El, opts: { text?: string; progress?: number } = {}): Spec | null {
    const common = { page: el.page, opacity: el.opacity }
    switch (el.kind) {
      case 'box':
        return {
          ...common,
          kind: 'shape',
          x: el.x,
          y: el.y,
          w: el.w,
          h: el.h,
          geo: el.geo,
          color: el.color,
          label: boxLabel(el),
          ...(el.link ? { link: el.link } : {})
        }
      case 'text':
        return {
          ...common,
          kind: 'text',
          x: el.x,
          y: el.y,
          text: opts.text ?? el.text,
          color: el.color,
          size: TEXT_SIZE[el.size]
        }
      case 'group':
        return {
          ...common,
          kind: 'frame',
          x: el.x,
          y: el.y,
          w: el.w,
          h: el.h,
          label: el.label,
          back: true
        }
      case 'shot': {
        const image = this.scene.spec(el.id)
        return {
          ...common,
          kind: 'frame',
          x: el.x,
          y: el.y,
          w: el.w,
          h: el.h,
          label: el.label,
          // Keep the picture already showing until a retaken one has loaded.
          ...(image?.kind === 'frame' && image.image ? { image: image.image } : {})
        }
      }
      case 'arrow': {
        const from = this.endId(el.page, el.from)
        const to = this.endId(el.page, el.to)
        if (!from || !to) return null
        return {
          ...common,
          kind: 'arrow',
          from,
          to,
          bend: el.bend,
          color: 'black',
          dashed: el.dashed,
          label: el.label,
          progress: opts.progress ?? 1
        }
      }
    }
  }

  private put(el: El, opts?: { text?: string; progress?: number; opacity?: number }): boolean {
    const spec = this.specFor(el, opts)
    if (!spec || this.disposed) return false
    this.scene.set(el.id, opts?.opacity !== undefined ? { ...spec, opacity: opts.opacity } : spec)
    if (el.kind === 'shot') void this.fillShot(el)
    return true
  }

  /** Put a screenshot's picture into its frame, once it has loaded. */
  private async fillShot(el: ShotEl): Promise<void> {
    if (this.shown.get(el.id) === el.rev) return
    this.shown.set(el.id, el.rev)
    const src = await this.loadImage(el.image.file).catch(() => null)
    const spec = this.scene.spec(el.id)
    if (!src || !this.exists(el.id) || spec?.kind !== 'frame' || this.shown.get(el.id) !== el.rev)
      return
    this.scene.set(el.id, { ...spec, image: src })
  }

  /** The scene id of the shape an arrow end names (a box, group or screenshot on the arrow's page). */
  private endId(page: string, name: string): string | null {
    for (const kind of ['box', 'group', 'shot']) {
      const id = `${page}~${kind}~${name}`
      if (this.scene.has(id)) return id
    }
    return null
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
    const scene = this.scene
    switch (fx.fx) {
      case 'rename':
        // Page names live in the tabs above the board, not in the scene.
        scene.ensurePage(fx.page.id)
        return
      case 'page': {
        if (scene.page === fx.page.id) return
        const svg = scene.svg
        svg.style.transition = 'opacity 180ms'
        svg.style.opacity = '0'
        await sleep(180)
        if (this.disposed) return
        scene.showPage(fx.page.id)
        this.frameCamera(0)
        svg.style.opacity = '1'
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
        const ids = fx.ids.filter((id) => this.exists(id))
        const from = new Map(ids.map((id) => [id, scene.opacity(id)]))
        await animate(fx.ms, (p) => {
          for (const id of ids) {
            if (this.exists(id))
              scene.setOpacity(id, from.get(id)! + (fx.opacity - from.get(id)!) * ease(p))
          }
        })
        return
      }
      case 'delete': {
        const ids = fx.ids.filter((id) => this.exists(id))
        if (!ids.length) return
        const from = new Map(ids.map((id) => [id, scene.opacity(id)]))
        await animate(fx.ms, (p) => {
          for (const id of ids) {
            if (this.exists(id)) scene.setOpacity(id, from.get(id)! * (1 - ease(p)))
          }
        })
        for (const id of ids) if (this.exists(id)) scene.remove(id)
        return
      }
      case 'circle':
        await this.circle(fx.page, fx.bounds, fx.ms)
        return
      case 'pulse': {
        const id = fx.id
        if (!this.exists(id)) return
        const base = scene.opacity(id)
        await animate(fx.ms, (p) => {
          if (this.exists(id))
            scene.setOpacity(id, base * (1 - 0.7 * Math.abs(Math.sin(p * Math.PI * 2))))
        })
        if (this.exists(id)) scene.setOpacity(id, base)
        return
      }
    }
  }

  private async add(el: El, ms: number): Promise<void> {
    if (this.exists(el.id)) return
    if (el.kind === 'arrow') {
      // Arrows grow from start to end; the label comes once it's there.
      if (!this.put(el, { progress: 0 })) return
      await animate(ms, (p) => {
        if (this.exists(el.id)) this.put(el, { progress: ease(p) })
      })
      return
    }
    if (el.kind === 'text') {
      // Text types itself on.
      this.put(el, { text: '' })
      let shown = -1
      await animate(ms, (p) => {
        const n = Math.round(p * el.text.length)
        if (n === shown || !this.exists(el.id)) return
        shown = n
        this.put(el, { text: el.text.slice(0, n) })
      })
      return
    }
    // Boxes, groups and screenshots fade in.
    this.put(el, { opacity: 0 })
    await animate(ms, (p) => {
      if (this.exists(el.id)) this.scene.setOpacity(el.id, el.opacity * ease(p))
    })
  }

  private async update(el: El, ms: number): Promise<void> {
    const before = this.scene.spec(el.id)
    if (!before || el.kind === 'arrow' || el.kind === 'text') return
    if (before.kind !== 'shape' && before.kind !== 'frame') return
    const x0 = before.x
    const y0 = before.y
    // Colour, label, link and opacity change at once; a move glides.
    this.put({ ...el, x: x0, y: y0 })
    if (x0 === el.x && y0 === el.y) return
    await animate(ms, (p) => {
      if (!this.exists(el.id)) return
      const e = ease(p)
      this.put({ ...el, x: x0 + (el.x - x0) * e, y: y0 + (el.y - y0) * e })
    })
    this.frameCamera(400)
  }

  /**
   * A hand-drawn red ring around an area: it draws on, stays while the
   * sentence is spoken, then fades away by itself. Only the drawing-on is
   * waited for, so the next line isn't held up.
   */
  private async circle(page: string, b: Bounds, ms: number): Promise<void> {
    const id = `~ring~${this.rings++}`
    const w = b.w * 1.15 + 36
    const h = b.h * 1.3 + 30
    const cx = b.x + b.w / 2
    const cy = b.y + b.h / 2
    const ring = (scale: number, opacity: number): void => {
      if (this.disposed) return
      this.scene.set(id, {
        kind: 'ring',
        page,
        x: cx - (w * scale) / 2,
        y: cy - (h * scale) / 2,
        w: w * scale,
        h: h * scale,
        color: 'red',
        opacity
      })
    }
    ring(0.8, 0)
    await animate(CIRCLE_IN_MS, (p) => ring(0.8 + 0.2 * ease(p), ease(p)))
    void (async () => {
      await sleep(Math.max(0, ms - CIRCLE_IN_MS - CIRCLE_OUT_MS))
      await animate(CIRCLE_OUT_MS, (p) => {
        if (this.exists(id)) ring(1, 1 - ease(p))
      })
      if (this.exists(id)) this.scene.remove(id)
    })()
  }

  // ---- camera

  /**
   * Keep the drawing in the uncovered part of the screen as it grows, without
   * zooming in past 100%. An empty page starts at a friendly offset.
   */
  frameCamera(ms = 500): void {
    if (this.disposed) return
    const scene = this.scene
    const to = fitCamera(scene.contentBounds(), scene.viewport(), this.insets(), scene.camera)
    if (to) void scene.moveCamera(to, ms)
  }
}
