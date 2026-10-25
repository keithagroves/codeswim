// The Electron-free half of the browser panel (browser-host.ts): which URLs
// it will load, the script it runs inside pages, and the checks on what that
// script hands back.
//
// The page script runs in an isolated world (executeJavaScriptInIsolatedWorld):
// it shares the page's DOM but not its JavaScript, so the page can't see or
// tamper with it. It's kept as a plain string, not a function's toString(),
// because the main bundle is transformed by esbuild and a helper it injects
// wouldn't exist inside the page.

import type { PageElement, PageMatch, PageOutline } from '@codeswim/contract'

/** The isolated world the page script lives in; its globals persist until the page navigates. */
export const PAGE_WORLD_ID = 1999

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0'])

/**
 * An address-bar entry as a URL to load, or an error message. Only http(s):
 * a bare host gets http:// when it's local or has a port (a dev server),
 * https:// otherwise. 0.0.0.0 — what many dev servers print — becomes
 * localhost, since Chromium refuses to load it.
 */
export function normalizeBrowserUrl(input: string): { url: string } | { error: string } {
  const raw = input.trim()
  if (!raw) return { error: 'Enter an address.' }
  if (raw.length > 2048) return { error: 'That address is too long.' }
  let candidate = raw
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw) || /^[^/:]+:\d+(\/|$)/.test(raw)) {
    const host = raw.split(/[/:?#]/)[0].toLowerCase()
    const local = LOOPBACK.has(host) || /^127\./.test(host) || /^[^/]+:\d+/.test(raw)
    candidate = `${local ? 'http' : 'https'}://${raw}`
  }
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return { error: `Not an address: ${raw}` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: 'Only http and https pages open here.' }
  }
  if (url.hostname === '0.0.0.0') url.hostname = 'localhost'
  return { url: url.toString() }
}

/** Whether a navigation the page starts itself may go ahead. */
export function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export const OUTLINE_LIMITS = { elements: 80, text: 3000, label: 80 } as const

// Installs `window.__codeswim` in the isolated world once per page. Element
// refs (e1, e2, ...) are kept in a WeakRef map there, so a ref from an
// earlier inspect still points at the same element until the page navigates.
const SETUP = String.raw`
(() => {
  if (window.__codeswim) return
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
  const SEL = 'a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=menuitem],[role=switch],[role=textbox],h1,h2,h3,h4,h5,h6,[role=heading],img[alt]'
  const STYLE = ['fontSize', 'fontWeight', 'color', 'backgroundColor', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderRadius']
  const state = { refs: new Map(), byEl: new WeakMap(), next: 1, rings: [] }
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return false
    const cs = getComputedStyle(el)
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05
  }
  const roleOf = (el) => {
    const tag = el.tagName.toLowerCase()
    const role = (el.getAttribute('role') || '').toLowerCase()
    if (role === 'textbox') return 'input'
    if (role === 'switch') return 'checkbox'
    if (role) return role
    if (tag === 'a') return 'link'
    if (tag === 'button' || tag === 'summary') return 'button'
    if (tag === 'input') return ['button', 'submit', 'reset'].includes(el.type) ? 'button' : el.type === 'checkbox' ? 'checkbox' : 'input'
    if (tag === 'textarea' || tag === 'select') return 'input'
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'img') return 'image'
    return tag
  }
  const labelOf = (el) => norm(
    el.getAttribute('aria-label') || el.innerText || (el.tagName === 'INPUT' && el.type !== 'password' ? el.value : '') ||
    el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('name') || ''
  )
  const refOf = (el) => {
    let ref = state.byEl.get(el)
    if (!ref) {
      ref = 'e' + state.next++
      state.byEl.set(el, ref)
      state.refs.set(ref, new WeakRef(el))
    }
    return ref
  }
  const describe = (el, maxLabel) => {
    const r = el.getBoundingClientRect()
    const role = roleOf(el)
    const out = {
      ref: refOf(el),
      role,
      text: labelOf(el).slice(0, maxLabel),
      box: { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), width: Math.round(r.width), height: Math.round(r.height) }
    }
    if (role === 'link' && el.href) out.href = el.href
    if (role === 'button' || role === 'link' || role === 'input' || role === 'checkbox' || role === 'tab') {
      const cs = getComputedStyle(el)
      out.style = {}
      for (const k of STYLE) out.style[k] = cs[k]
    }
    return out
  }
  const candidates = () => [...document.querySelectorAll(SEL)].filter(visible)
  const find = (target, all) => {
    const t = norm(target)
    if (!t) return []
    if (/^e\d+$/.test(t)) {
      const el = state.refs.get(t)?.deref()
      return el && el.isConnected ? [el] : []
    }
    const lower = t.toLowerCase()
    const els = candidates()
    let hits = els.filter((el) => labelOf(el).toLowerCase() === lower)
    if (!hits.length) hits = els.filter((el) => labelOf(el).toLowerCase().includes(lower))
    if (!hits.length) {
      try {
        hits = [...document.querySelectorAll(t)].filter(visible)
      } catch {}
    }
    if (!hits.length && document.body) {
      // Any other visible element whose own text is that (a card title, a label).
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n && hits.length < 12; n = walker.nextNode()) {
        if (norm(n.textContent).toLowerCase() !== lower) continue
        const el = n.parentElement
        if (el && visible(el) && !hits.includes(el)) hits.push(el)
      }
    }
    return all ? hits.slice(0, 12) : hits.slice(0, 1)
  }
  const clearRings = () => {
    for (const r of state.rings) r.remove()
    state.rings = []
  }
  const ring = (el, ms) => {
    const div = document.createElement('codeswim-ring')
    const set = (k, v) => div.style.setProperty(k, v, 'important')
    set('position', 'fixed'); set('pointer-events', 'none'); set('z-index', '2147483647')
    set('border', '3px solid #ff9f1c'); set('border-radius', '8px'); set('box-sizing', 'border-box')
    set('box-shadow', '0 0 0 4px rgba(255, 159, 28, 0.25)'); set('transition', 'opacity 300ms'); set('display', 'block')
    document.documentElement.appendChild(div)
    state.rings.push(div)
    const until = performance.now() + ms
    const follow = () => {
      if (!div.isConnected) return
      const r = el.getBoundingClientRect()
      set('left', r.left - 6 + 'px'); set('top', r.top - 6 + 'px')
      set('width', r.width + 12 + 'px'); set('height', r.height + 12 + 'px')
      if (performance.now() < until) requestAnimationFrame(follow)
      else {
        set('opacity', '0')
        setTimeout(() => div.remove(), 320)
      }
    }
    follow()
  }
  window.__codeswim = {
    outline(limits) {
      const elements = []
      let truncated = false
      for (const el of candidates()) {
        if (elements.length >= limits.elements) { truncated = true; break }
        const d = describe(el, limits.label)
        if (d.text || d.role === 'input' || d.role === 'image') elements.push(d)
      }
      const text = norm(document.body ? document.body.innerText : '')
      if (text.length > limits.text) truncated = true
      return {
        url: location.href,
        title: document.title,
        viewport: { width: innerWidth, height: innerHeight, scrollY: Math.round(scrollY), pageHeight: document.documentElement.scrollHeight },
        elements,
        text: text.slice(0, limits.text),
        truncated
      }
    },
    point(target, all, ms, maxLabel) {
      const hits = find(target, all)
      clearRings()
      if (hits.length) hits[0].scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
      for (const el of hits) ring(el, ms)
      return hits.length ? hits.map((el) => ({ target, found: true, element: describe(el, maxLabel) })) : [{ target, found: false }]
    },
    measure(targets, maxLabel) {
      return targets.map((target) => {
        const el = find(target, false)[0]
        return el ? { target, found: true, element: describe(el, maxLabel) } : { target, found: false }
      })
    }
  }
})();
`

/** The isolated-world code for an outline of the page. */
export function outlineScript(): string {
  return `${SETUP}\nwindow.__codeswim.outline(${JSON.stringify(OUTLINE_LIMITS)})`
}

/** Scroll to and ring the element(s) matching `target`. */
export function pointScript(target: string, all: boolean, ms = 2500): string {
  return `${SETUP}\nwindow.__codeswim.point(${JSON.stringify(target)}, ${all ? 'true' : 'false'}, ${ms}, ${OUTLINE_LIMITS.label})`
}

export function measureScript(targets: string[]): string {
  return `${SETUP}\nwindow.__codeswim.measure(${JSON.stringify(targets)}, ${OUTLINE_LIMITS.label})`
}

// ---- checks on what the page script returns
//
// The script is ours, but everything it reads is the page's: text, sizes,
// links. Bound and type-check all of it before it reaches a prompt or IPC.

const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')

function toElement(raw: unknown): PageElement | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const ref = str(o.ref, 12)
  if (!/^e\d+$/.test(ref)) return null
  const box = (o.box ?? {}) as Record<string, unknown>
  const el: PageElement = {
    ref,
    role: str(o.role, 20) || 'element',
    text: str(o.text, OUTLINE_LIMITS.label),
    box: { x: num(box.x), y: num(box.y), width: num(box.width), height: num(box.height) }
  }
  if (typeof o.href === 'string' && isWebUrl(o.href)) el.href = o.href.slice(0, 500)
  if (o.style && typeof o.style === 'object') {
    const style: Record<string, string> = {}
    for (const [k, v] of Object.entries(o.style as Record<string, unknown>).slice(0, 12)) {
      if (typeof v === 'string' && v.length <= 60) style[k] = v
    }
    el.style = style
  }
  return el
}

export function toOutline(raw: unknown): PageOutline {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const vp = (o.viewport ?? {}) as Record<string, unknown>
  const elements = (Array.isArray(o.elements) ? o.elements : [])
    .slice(0, OUTLINE_LIMITS.elements)
    .map(toElement)
    .filter((e): e is PageElement => e !== null)
  return {
    url: str(o.url, 2048),
    title: str(o.title, 200),
    viewport: {
      width: num(vp.width),
      height: num(vp.height),
      scrollY: num(vp.scrollY),
      pageHeight: num(vp.pageHeight)
    },
    elements,
    text: str(o.text, OUTLINE_LIMITS.text),
    truncated: o.truncated === true
  }
}

export function toMatches(raw: unknown): PageMatch[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, 20).map((m) => {
    const o = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>
    const element = o.found === true ? toElement(o.element) : null
    return element
      ? { target: str(o.target, 200), found: true, element }
      : { target: str(o.target, 200), found: false }
  })
}

/** A point/measure target: visible text, a ref, or a CSS selector. */
export function isTarget(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= 200
}

/** Screenshots kept per workspace; older ones are pruned. */
export const MAX_SCREENSHOTS = 20

export function screenshotName(now: Date): string {
  return `screenshot-${now.toISOString().replace(/[:.]/g, '-')}.png`
}

/** Of the files in the screenshot folder, the ones to delete (oldest first) to stay under the cap. */
export function screenshotsToPrune(files: string[], keep = MAX_SCREENSHOTS): string[] {
  const shots = files.filter((f) => /^screenshot-.*\.png$/.test(f)).sort()
  return shots.slice(0, Math.max(0, shots.length - keep))
}
