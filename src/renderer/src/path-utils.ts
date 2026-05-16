// POSIX-style path utilities for the renderer.
// We always work with forward-slash paths internally; the main process
// converts to/from OS-native paths only at IPC boundaries.

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

export function dirname(p: string): string {
  const idx = p.lastIndexOf('/')
  if (idx < 0) return ''
  if (idx === 0) return '/'
  return p.slice(0, idx)
}

export function joinPosix(...parts: string[]): string {
  const filtered = parts.filter((p) => p.length > 0)
  if (filtered.length === 0) return ''
  return filtered.join('/').replace(/\/+/g, '/')
}

export function normalize(p: string): string {
  const isAbsolute = p.startsWith('/')
  const segments = p.split('/').filter((s) => s.length > 0 && s !== '.')
  const stack: string[] = []
  for (const seg of segments) {
    if (seg === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') stack.pop()
      else if (!isAbsolute) stack.push('..')
    } else {
      stack.push(seg)
    }
  }
  const result = stack.join('/')
  return isAbsolute ? '/' + result : result
}

export function resolveRelative(currentFile: string, target: string): string {
  // currentFile is a relative-to-root path (e.g. "billing/charge-flow.md")
  // target is relative to currentFile's directory (e.g. "./refund.md", "../shared/db.md")
  const currentDir = dirname(currentFile)
  const joined = currentDir ? joinPosix(currentDir, target) : target
  return normalize(joined)
}

export function basename(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx < 0 ? p : p.slice(idx + 1)
}

export function extname(p: string): string {
  const base = basename(p)
  const idx = base.lastIndexOf('.')
  if (idx <= 0) return ''
  return base.slice(idx).toLowerCase()
}

export function relativeToRoot(rootPath: string, absPath: string): string | null {
  const root = toPosix(rootPath).replace(/\/$/, '')
  const abs = toPosix(absPath)
  if (abs === root) return ''
  if (!abs.startsWith(root + '/')) return null
  return abs.slice(root.length + 1)
}

export interface LineRange {
  start: number // 1-indexed, inclusive
  end: number // 1-indexed, inclusive
}

// Splits a navigate target into its path and optional line ref. Accepts:
//   "./foo.ts"           → { path: "./foo.ts", range: null }
//   "./foo.ts#L10"       → { path: "./foo.ts", range: { start: 10, end: 10 } }
//   "./foo.ts#L10-L22"   → { path: "./foo.ts", range: { start: 10, end: 22 } }
//   "./foo.ts#L10-22"    → same (shorter form)
//   "./foo.ts#bad"       → { path: "./foo.ts", range: null }  (silent fallback)
// Also drops any `?query` suffix so it never leaks into the resolved path.
const LINE_REF_RE = /^L(\d+)(?:-L?(\d+))?$/i

export function parseTarget(target: string): { path: string; range: LineRange | null } {
  // Split on `#` first so a query string before the fragment doesn't eat it.
  const hashIdx = target.indexOf('#')
  const pathPart = hashIdx < 0 ? target : target.slice(0, hashIdx)
  const frag = hashIdx < 0 ? '' : target.slice(hashIdx + 1)
  const path = pathPart.split('?')[0]
  if (!frag) return { path, range: null }
  const m = frag.match(LINE_REF_RE)
  if (!m) return { path, range: null }
  const start = Number.parseInt(m[1], 10)
  const end = m[2] !== undefined ? Number.parseInt(m[2], 10) : start
  if (!Number.isFinite(start) || start < 1) return { path, range: null }
  return {
    path,
    range: { start, end: Math.max(start, Number.isFinite(end) && end >= start ? end : start) }
  }
}
