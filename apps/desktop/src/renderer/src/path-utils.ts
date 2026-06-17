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

// Resolve a loose, agent-typed path token (e.g. one mentioned in chat prose)
// to a real workspace file. Agent output is inconsistent — it may write a
// root-relative path ("server/overview.md"), a bare filename ("http-routes.md"),
// or an explanation-doc path ("src/foo.ts.md"). We match against the known file
// list so only real files ever become links; a miss stays plain text rather
// than a dead link:
//   1. exact match on the normalized path
//   2. unique suffix match (the token is a trailing path slice of one file)
//   3. unique basename match (exactly one file shares the leaf name)
// More than one match at a tier is ambiguous → null; we never guess between
// files. Tokens with neither a separator nor an extension (e.g. an identifier
// like `runFlow`) are rejected up front so ordinary inline code stays unlinked.
export function resolveWorkspacePath(raw: string, files: string[]): string | null {
  const trimmed = raw.trim().replace(/\/+$/, '') // drop trailing slash (directories)
  if (!trimmed) return null
  const candidate = normalize(trimmed.replace(/^\.\//, ''))
  if (!candidate || candidate.startsWith('..')) return null
  if (!candidate.includes('/') && !candidate.includes('.')) return null

  if (files.includes(candidate)) return candidate

  const suffix = '/' + candidate
  const suffixMatches = files.filter((f) => f.endsWith(suffix))
  if (suffixMatches.length === 1) return suffixMatches[0]
  if (suffixMatches.length > 1) return null

  const leaf = basename(candidate)
  const baseMatches = files.filter((f) => basename(f) === leaf)
  return baseMatches.length === 1 ? baseMatches[0] : null
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
