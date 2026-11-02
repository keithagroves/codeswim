// Text wrapping and the camera, in plain numbers. Text width comes from a
// measuring function the scene supplies (a canvas in the browser, a fixed
// width per character in tests).

import type { Pt, Rect } from './geometry'

/** Width of `text` in px at the current font. */
export type Measure = (text: string) => number

/** Break text into lines no wider than maxWidth; a word too long for a line is split. */
export function wrap(text: string, maxWidth: number, measure: Measure): string[] {
  const lines: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word
      if (measure(next) <= maxWidth || !line) {
        line = next
      } else {
        lines.push(line)
        line = word
      }
      // A single word wider than the line: cut it where it overflows.
      while (measure(line) > maxWidth && line.length > 1) {
        let cut = line.length - 1
        while (cut > 1 && measure(line.slice(0, cut)) > maxWidth) cut--
        lines.push(line.slice(0, cut))
        line = line.slice(cut)
      }
    }
    lines.push(line)
  }
  return lines
}

/** Screen = (page + camera) × zoom, as tldraw had it. */
export interface Camera {
  x: number
  y: number
  z: number
}

/** Screen space covered by overlays, kept clear of the drawing. */
export interface Insets {
  left: number
  top: number
  right: number
  bottom: number
}

export function toPage(cam: Camera, screen: Pt): Pt {
  return [screen[0] / cam.z - cam.x, screen[1] / cam.z - cam.y]
}

/** Zoom to z, keeping the page point under `screen` where it is. */
export function zoomAt(cam: Camera, screen: Pt, z: number): Camera {
  const p = toPage(cam, screen)
  return { x: screen[0] / z - p[0], y: screen[1] / z - p[1], z }
}

/**
 * Where to put the camera so the content sits in the uncovered part of the
 * screen, never zoomed in past 100%. Null when it's already in view. An empty
 * page starts at a friendly offset.
 */
export function fitCamera(
  content: Rect | null,
  viewport: { w: number; h: number },
  cover: Insets,
  cam: Camera,
  margin = 40
): Camera | null {
  if (!content) return { x: cover.left + 60, y: cover.top + 200, z: 1 }
  const [ax, ay] = toPage(cam, [cover.left + margin, cover.top + margin])
  const [bx, by] = toPage(cam, [
    viewport.w - cover.right - margin,
    viewport.h - cover.bottom - margin
  ])
  if (
    content.x >= ax &&
    content.y >= ay &&
    content.x + content.w <= bx &&
    content.y + content.h <= by
  )
    return null
  const fw = Math.max(100, viewport.w - cover.left - cover.right - 2 * margin)
  const fh = Math.max(100, viewport.h - cover.top - cover.bottom - 2 * margin)
  const z = Math.max(0.1, Math.min(1, fw / (content.w || 1), fh / (content.h || 1)))
  const cx = cover.left + margin + fw / 2
  const cy = cover.top + margin + fh / 2
  return { x: cx / z - (content.x + content.w / 2), y: cy / z - (content.y + content.h / 2), z }
}
