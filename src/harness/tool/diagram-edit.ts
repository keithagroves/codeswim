import path from 'node:path'
import yaml from 'js-yaml'
import type { SessionGate } from '../session-gate'

export interface DiagramEditParams {
  file: string
  content: string
}

export interface DiagramEditResult {
  kind: 'created' | 'replaced'
  file: string
  before: string | null
  after: string
}

export interface DiagramFs {
  exists(absPath: string): Promise<boolean>
  readFile(absPath: string): Promise<string>
  writeFile(absPath: string, content: string): Promise<void>
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
const FENCE_OPEN_RE = /^( {0,3})(`{3,}|~{3,})([^\r\n]*)/

function parseFrontmatter(content: string): Record<string, unknown> | null {
  const m = content.match(FRONTMATTER_RE)
  if (!m) return null
  try {
    const obj = yaml.load(m[1])
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function countMermaidBlocks(content: string): number {
  const lines = content.split(/\r?\n/)
  let fenceChar: string | null = null
  let fenceLength = 0
  let count = 0
  for (const line of lines) {
    const m = line.match(FENCE_OPEN_RE)
    if (!m) continue
    const seq = m[2]
    const ch = seq[0]
    const len = seq.length
    if (fenceChar === null) {
      fenceChar = ch
      fenceLength = len
      const info = m[3].trim().toLowerCase().split(/\s+/)[0]
      const isMermaid = info === 'mermaid' || info === '{mermaid}' || info.startsWith('{mermaid,')
      if (isMermaid) count++
    } else if (ch === fenceChar && len >= fenceLength && m[3].trim() === '') {
      fenceChar = null
      fenceLength = 0
    }
  }
  return count
}

export function validatePath(file: string): string | null {
  if (!file) return 'file is required'
  if (path.isAbsolute(file)) return 'file must be a relative path, not absolute'
  if (!file.toLowerCase().endsWith('.md')) return 'diagram files must end in .md'
  const normalized = path.posix.normalize(file.replace(/\\/g, '/'))
  if (normalized === '.' || normalized === '') return 'file is required'
  if (normalized.split('/').some((p) => p === '..')) {
    return 'file path must not escape workspace root'
  }
  return null
}

export function validateContent(content: string): string | null {
  const fm = parseFrontmatter(content)
  if (!fm) return 'frontmatter is missing or malformed (expected `---` block at top of file)'
  if (typeof fm.name !== 'string' || !fm.name.trim()) {
    return 'frontmatter must include `name` (a short title)'
  }
  if (typeof fm.description !== 'string' || !fm.description.trim()) {
    return 'frontmatter must include `description` (one-line summary)'
  }
  if (!Array.isArray(fm.tags)) {
    return 'frontmatter must include `tags` as a list (e.g. tags: [overview, architecture])'
  }
  const blocks = countMermaidBlocks(content)
  if (blocks === 0) return 'diagram file must contain a ```mermaid block'
  if (blocks > 1) {
    return `diagram file must contain exactly one mermaid block (found ${blocks}); the renderer only shows the first`
  }
  return null
}

export async function diagramEdit(
  params: DiagramEditParams,
  ctx: {
    workspaceRoot: string
    fs: DiagramFs
    gate?: SessionGate
    sessionId?: string
  }
): Promise<DiagramEditResult> {
  const pathErr = validatePath(params.file)
  if (pathErr) throw new Error(`diagram_edit: ${pathErr}`)
  const contentErr = validateContent(params.content)
  if (contentErr) throw new Error(`diagram_edit: ${contentErr}`)

  const abs = path.resolve(ctx.workspaceRoot, params.file)
  const exists = await ctx.fs.exists(abs)
  const before = exists ? await ctx.fs.readFile(abs) : null
  await ctx.fs.writeFile(abs, params.content)
  if (ctx.gate && ctx.sessionId) ctx.gate.markDiagramEdited(ctx.sessionId)
  return {
    kind: exists ? 'replaced' : 'created',
    file: params.file,
    before,
    after: params.content
  }
}
