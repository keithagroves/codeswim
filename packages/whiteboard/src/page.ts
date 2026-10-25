// The web page beside the board: what the narrator is told about it, the
// lines it uses to point at it, and how a build changed it.
//
// When the person has their running app open in the browser panel, every
// request carries a <page> block (an outline of what's on screen, with
// sizes), and the narrator can point at things while it talks:
//
//   {"point":"Sign up"}                      ring the element with that text
//   {"show":"http://localhost:5173/pricing"} open a page of their running app
//   {"start":"dev"}                          start their dev server, then open it
//
// Before a build the page is outlined, and after it the page is reloaded and
// outlined again; the difference (sizes, styles, elements added or gone)
// goes into the walkthrough's checkpoint, so "they're 280 pixels wide now"
// comes from a measurement rather than the model's guess.

import { clean, type Cmd, type RawLine } from './protocol'

/** One element of the page, as the browser panel outlines it (structurally the contract's PageElement). */
export interface PageItem {
  role: string
  text: string
  box: { width: number; height: number }
  style?: Record<string, string>
}

export interface PageSnapshot {
  url: string
  title: string
  elements: PageItem[]
  text?: string
}

/** A line about the page rather than the board. */
export type PageCmd =
  | { op: 'point'; target: string; all: boolean }
  | { op: 'show'; url: string }
  | { op: 'start'; name: string }

export function isPageCmd(a: Cmd | PageCmd): a is PageCmd {
  return a.op === 'point' || a.op === 'show' || a.op === 'start'
}

export function toPageCmd(o: RawLine): PageCmd | null {
  if (typeof o.point === 'string') {
    const target = clean(o.point, 80)
    return target ? { op: 'point', target, all: o.all === true } : null
  }
  if (typeof o.show === 'string') {
    const url = o.show.trim()
    return url && url.length <= 500 ? { op: 'show', url } : null
  }
  if (typeof o.start === 'string') {
    const name = o.start.trim()
    return name && name.length <= 60 ? { op: 'start', name } : null
  }
  return null
}

const NOT_A_SERVER =
  /\b(build|test|lint|deploy|release|publish|clean|format|typecheck|check|e2e|ci|migrate|seed)\b/i
const SERVER_NAME =
  /(^|[:_-])(dev|start|serve|server|preview|storybook|develop|watch|web|client|frontend|site)($|[:_-])/i
const SERVER_COMMAND =
  /\b(vite|next (dev|start)|nuxt|astro dev|remix dev|webpack(-dev-server| serve)|parcel|http-server|live-server|serve|react-scripts start|ng serve|storybook|gatsby develop|expo start|wrangler dev|hugo server|jekyll serve|http\.server|rails s(erver)?|flask run|uvicorn|php -S)\b/i

/**
 * Whether a run (an npm script or a custom run) looks like it starts a dev
 * server — the only kind the narrator may start, since starting a script
 * stops whatever was running and some scripts deploy or delete things.
 */
export function looksLikeServer(run: { name: string; command: string }): boolean {
  if (NOT_A_SERVER.test(run.name)) return false
  return SERVER_NAME.test(run.name) || SERVER_COMMAND.test(run.command)
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i

/**
 * The narrator may open the person's own running app (a local address) or
 * another page of the site already showing — never somewhere new on the web.
 */
export function canShow(url: string, current: string | null): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  if (LOOPBACK.test(u.hostname)) return true
  if (!current) return false
  try {
    return new URL(current).origin === u.origin
  } catch {
    return false
  }
}

const MAX_ITEMS = 40
const SIZED = new Set(['button', 'input', 'image', 'checkbox', 'tab'])

const quote = (s: string): string => `"${s.replace(/"/g, "'")}"`
const size = (b: { width: number; height: number }): string => `${b.width}×${b.height}`

/**
 * The <page> block: the page beside the board, or where the person's app is
 * running when no page is open. Empty when there's neither.
 */
/** What the narrator is told when no page is open: where the app is running, or how to start it. */
export interface PageContext {
  /** Local addresses printed by the script that's running now. */
  devUrls?: string[]
  /** Dev-server runs it may start with a start line; empty while any script runs. */
  servers?: string[]
  /** A script that's running but hasn't printed a local address. */
  running?: string | null
}

export function formatPage(page: PageSnapshot | null, ctx: PageContext = {}): string {
  if (!page) {
    const none = 'No web page is open beside the board.'
    if (ctx.devUrls?.length)
      return `${none} The person's app is running at ${ctx.devUrls[0]}. When they want to see it, open it with {"show":"${ctx.devUrls[0]}"}.`
    if (ctx.running)
      return `${none} Their script "${ctx.running}" is running but hasn't printed a local address yet, so there's nothing to open. Say so.`
    if (ctx.servers?.length)
      return `${none} The app isn't running. When they want to see it, start its dev server with ${ctx.servers.map((s) => `{"start":"${s}"}`).join(' or ')} (pick one). It opens beside the board once it's up, and you'll be asked again then.`
    return `${none} There's no dev server script to start. If they want to see their app, ask them to start it and open it with the globe button at the top right.`
  }
  const lines = [
    'The person has this web page open beside the board (their running app). Point at its elements by their text, exactly as listed.',
    `url: ${page.url}`,
    page.title ? `title: ${quote(page.title)}` : ''
  ].filter(Boolean)
  const items = page.elements.filter((e) => e.text || SIZED.has(e.role)).slice(0, MAX_ITEMS)
  if (items.length) {
    lines.push('Elements (role, text, width×height in pixels):')
    for (const e of items) {
      lines.push(
        `- ${e.role} ${quote(e.text || '(no text)')}${SIZED.has(e.role) ? ` ${size(e.box)}` : ''}`
      )
    }
    if (page.elements.length > items.length)
      lines.push(`…and ${page.elements.length - items.length} more`)
  }
  const text = page.text?.trim()
  if (text) lines.push(`Visible text: ${text.slice(0, 600)}${text.length > 600 ? '…' : ''}`)
  return lines.join('\n')
}

const STYLE_NAMES: Record<string, string> = {
  fontSize: 'font size',
  fontWeight: 'font weight',
  color: 'text color',
  backgroundColor: 'background',
  paddingTop: 'top padding',
  paddingRight: 'right padding',
  paddingBottom: 'bottom padding',
  paddingLeft: 'left padding',
  borderRadius: 'corner radius'
}

const MAX_CHANGES = 20

/**
 * How the page changed across a build, one line per change, quoting each
 * element's text so the narrator can point at it. Empty when nothing visible
 * changed. Elements are matched by role and text (in order, for repeats);
 * positions are ignored, since anything above a change moves everything below.
 */
export function diffPages(before: PageSnapshot, after: PageSnapshot): string[] {
  const out: string[] = []
  if (before.url !== after.url) out.push(`The page is now ${after.url} (was ${before.url}).`)
  const key = (e: PageItem): string => `${e.role}\u0000${e.text.toLowerCase()}`
  const pool = new Map<string, PageItem[]>()
  for (const e of before.elements) {
    const k = key(e)
    pool.set(k, [...(pool.get(k) ?? []), e])
  }
  const added: PageItem[] = []
  const changed = new Map<string, { label: string; parts: string[]; count: number }>()
  for (const a of after.elements) {
    const k = key(a)
    const b = pool.get(k)?.shift()
    if (!b) {
      added.push(a)
      continue
    }
    const parts: string[] = []
    if (Math.abs(a.box.width - b.box.width) >= 1 || Math.abs(a.box.height - b.box.height) >= 1)
      parts.push(`size ${size(b.box)} → ${size(a.box)} px`)
    for (const [prop, name] of Object.entries(STYLE_NAMES)) {
      const was = b.style?.[prop]
      const now = a.style?.[prop]
      if (was !== undefined && now !== undefined && was !== now)
        parts.push(`${name} ${was} → ${now}`)
    }
    if (!parts.length) continue
    // Several identical buttons changing the same way are one line.
    const label = `${a.role} ${quote(a.text || '(no text)')}`
    const sig = `${label}: ${parts.join(', ')}`
    const seen = changed.get(sig)
    if (seen) seen.count++
    else changed.set(sig, { label, parts, count: 1 })
  }
  for (const { label, parts, count } of changed.values()) {
    out.push(`${label}${count > 1 ? ` (all ${count})` : ''}: ${parts.join(', ')}`)
  }
  const removed = [...pool.values()].flat()
  for (const e of added.slice(0, 8)) out.push(`New: ${e.role} ${quote(e.text || '(no text)')}`)
  for (const e of removed.slice(0, 8)) out.push(`Gone: ${e.role} ${quote(e.text || '(no text)')}`)
  return out.slice(0, MAX_CHANGES)
}
