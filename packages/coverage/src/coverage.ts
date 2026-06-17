// Diagram coverage analysis — pure, dependency-free, testable.
// Operates on a snapshot of `{path, content}` pairs so it can run from the
// extension host, a CLI, or the Electron renderer.

import { lintMermaid, type MermaidIssue } from './mermaid-lint'

export interface FileInfo {
  path: string // posix, relative to workspace root
  content: string
}

export type LinkKind = 'navigate' | 'markdown'

export interface Link {
  // The raw target as written, including any leading "./" or "../".
  target: string
  // Posix path relative to root after resolution. Null if the target points
  // outside the workspace, is an external URL, or is just an anchor.
  resolvedPath: string | null
  line: number // 1-indexed
  column: number // 1-indexed
  kind: LinkKind
}

export interface BrokenLink extends Link {
  sourceFile: string // .md file the link came from
}

export interface CoverageOptions {
  // Predicate identifying files that count as "source code" for the coverage
  // metric. Defaults to a sensible mix of common languages.
  isSourceFile?: (path: string) => boolean
  // Predicate for "this is a diagram (markdown) file". Defaults to .md/.markdown.
  isDiagram?: (path: string) => boolean
  // Entry path for reachability. Defaults to overview.md at root if present,
  // otherwise the shallowest .md in alphabetical order.
  entry?: string
  // Predicate for files to skip entirely. Defaults to ignoring docs-internal
  // helpers like LICENSE, README, .gitignore — adjust as needed.
  ignore?: (path: string) => boolean
}

export interface CoverageReport {
  entry: string | null
  brokenLinks: BrokenLink[]
  orphanDiagrams: string[]
  uncoveredSources: string[]
  referencedFiles: string[] // sorted; every file that any diagram links to
  mermaidIssues: MermaidIssue[]
  totals: {
    diagrams: number
    sources: number
    coveredSources: number
    totalLinks: number
    brokenLinkCount: number
    mermaidIssueCount: number
  }
}

const DEFAULT_SOURCE_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.kt',
  '.rb',
  '.php',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.swift',
  '.scala',
  '.sql'
])

const DEFAULT_IGNORE_BASENAMES = new Set([
  'LICENSE',
  'LICENCE',
  'CHANGELOG.md',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.prettierrc',
  '.prettierignore',
  '.eslintrc',
  '.eslintrc.json',
  '.npmrc',
  '.nvmrc'
])

export function defaultIsSourceFile(path: string): boolean {
  const ext = extname(path)
  return DEFAULT_SOURCE_EXTS.has(ext)
}

export function defaultIsDiagram(path: string): boolean {
  const ext = extname(path).toLowerCase()
  return ext === '.md' || ext === '.markdown'
}

function defaultIgnore(path: string): boolean {
  const base = basename(path)
  return DEFAULT_IGNORE_BASENAMES.has(base)
}

function extname(p: string): string {
  const i = p.lastIndexOf('.')
  if (i < 0) return ''
  const slash = p.lastIndexOf('/')
  if (i < slash) return ''
  return p.slice(i).toLowerCase()
}

function basename(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? p : p.slice(i + 1)
}

function dirname(p: string): string {
  const i = p.lastIndexOf('/')
  if (i < 0) return ''
  return p.slice(0, i)
}

// POSIX-only normalize: strip "./" and resolve "../". Returns null if the
// path escapes the root.
function normalize(p: string): string | null {
  const segments = p.split('/').filter((s) => s.length > 0 && s !== '.')
  const stack: string[] = []
  for (const seg of segments) {
    if (seg === '..') {
      if (stack.length === 0) return null
      stack.pop()
    } else {
      stack.push(seg)
    }
  }
  return stack.join('/')
}

function resolveRelative(sourceFile: string, target: string): string | null {
  // Strip query string and hash so links like "./foo.md#section" still resolve.
  const cleaned = target.split('#')[0].split('?')[0]
  if (!cleaned) return null
  // Skip absolute and external URLs.
  if (/^[a-z][a-z0-9+.-]*:/i.test(cleaned)) return null
  if (cleaned.startsWith('/')) return null
  const dir = dirname(sourceFile)
  const joined = dir ? `${dir}/${cleaned}` : cleaned
  return normalize(joined)
}

const NAVIGATE_RE = /\bnavigate\(\s*"([^"\n]+)"\s*\)/g
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const FENCE_OPEN_RE = /^( {0,3})(`{3,}|~{3,})([^\r\n]*)/

function isMermaidFence(info: string): boolean {
  const first = info.trim().toLowerCase().split(/\s+/)[0]
  return first === 'mermaid' || first === '{mermaid}' || first.startsWith('{mermaid,')
}

export function extractLinks(file: FileInfo): Link[] {
  const links: Link[] = []
  const lines = file.content.split(/\r?\n/)

  // Track fenced-block state so navigate() calls are only treated as real
  // when they appear inside a mermaid block. Outside of mermaid (e.g., in
  // a `markdown` block that *documents* the navigate syntax), they're
  // illustrative and shouldn't count.
  let fenceChar: string | null = null
  let fenceLength = 0
  let inMermaid = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const fence = line.match(FENCE_OPEN_RE)
    if (fence) {
      const seq = fence[2]
      const ch = seq[0]
      const len = seq.length
      if (fenceChar === null) {
        // Opening a new fence.
        fenceChar = ch
        fenceLength = len
        inMermaid = isMermaidFence(fence[3])
      } else if (ch === fenceChar && len >= fenceLength && fence[3].trim() === '') {
        // Closing fence (same char, ≥ same length, empty info string).
        fenceChar = null
        fenceLength = 0
        inMermaid = false
      }
    }

    let match: RegExpExecArray | null

    if (inMermaid) {
      NAVIGATE_RE.lastIndex = 0
      while ((match = NAVIGATE_RE.exec(line)) !== null) {
        const target = match[1]
        links.push({
          target,
          resolvedPath: resolveRelative(file.path, target),
          line: i + 1,
          column: match.index + 1,
          kind: 'navigate'
        })
      }
    }

    // Markdown links are extracted everywhere — they're not fence-context
    // dependent, and links in prose are exactly the kind we want to verify.
    MARKDOWN_LINK_RE.lastIndex = 0
    while ((match = MARKDOWN_LINK_RE.exec(line)) !== null) {
      const target = match[2]
      const resolved = resolveRelative(file.path, target)
      if (resolved === null) continue
      links.push({
        target,
        resolvedPath: resolved,
        line: i + 1,
        column: match.index + 1,
        kind: 'markdown'
      })
    }
  }
  return links
}

function pickEntry(diagrams: string[]): string | null {
  if (diagrams.length === 0) return null
  // Only treat a root-level overview.md as the entry. An overview.md nested
  // inside `examples/`, `fixtures/`, etc. is documenting something else, not
  // the project itself.
  const rootOverview = diagrams.find((p) => p.toLowerCase() === 'overview.md')
  if (rootOverview) return rootOverview
  return null
}

export function analyzeCoverage(
  files: FileInfo[],
  options: CoverageOptions = {}
): CoverageReport {
  const isSource = options.isSourceFile ?? defaultIsSourceFile
  const isDiagram = options.isDiagram ?? defaultIsDiagram
  const ignore = options.ignore ?? defaultIgnore

  const filtered = files.filter((f) => !ignore(f.path))
  const fileSet = new Set(filtered.map((f) => f.path))
  const diagrams = filtered.filter((f) => isDiagram(f.path)).map((f) => f.path)
  const sources = filtered.filter((f) => isSource(f.path)).map((f) => f.path)

  // Collect all links per diagram.
  const linksByDiagram = new Map<string, Link[]>()
  for (const f of filtered) {
    if (!isDiagram(f.path)) continue
    linksByDiagram.set(f.path, extractLinks(f))
  }

  const brokenLinks: BrokenLink[] = []
  const referenced = new Set<string>()
  let totalLinks = 0

  for (const [sourceFile, links] of linksByDiagram) {
    for (const link of links) {
      totalLinks++
      if (link.resolvedPath === null) continue
      if (!fileSet.has(link.resolvedPath)) {
        brokenLinks.push({ ...link, sourceFile })
      } else {
        referenced.add(link.resolvedPath)
      }
    }
  }

  // Reachability from entry through diagram → diagram links.
  const entry = options.entry ?? pickEntry(diagrams)
  const reachable = new Set<string>()
  if (entry && fileSet.has(entry)) {
    const queue = [entry]
    reachable.add(entry)
    while (queue.length > 0) {
      const current = queue.shift()!
      const links = linksByDiagram.get(current) ?? []
      for (const link of links) {
        const target = link.resolvedPath
        if (!target || !isDiagram(target) || reachable.has(target)) continue
        if (!fileSet.has(target)) continue
        reachable.add(target)
        queue.push(target)
      }
    }
  }

  const orphanDiagrams = diagrams.filter((p) => !reachable.has(p)).sort()
  const uncoveredSources = sources.filter((p) => !referenced.has(p)).sort()
  const coveredSources = sources.length - uncoveredSources.length
  const mermaidIssues = lintMermaid(filtered)

  return {
    entry,
    brokenLinks,
    orphanDiagrams,
    uncoveredSources,
    referencedFiles: [...referenced].sort(),
    mermaidIssues,
    totals: {
      diagrams: diagrams.length,
      sources: sources.length,
      coveredSources,
      totalLinks,
      brokenLinkCount: brokenLinks.length,
      mermaidIssueCount: mermaidIssues.length
    }
  }
}
