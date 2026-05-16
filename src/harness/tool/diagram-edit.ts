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
  const blocks = extractMermaidBlocks(content)
  if (blocks.length === 0) return 'diagram file must contain a ```mermaid block'
  if (blocks.length > 1) {
    return `diagram file must contain exactly one mermaid block (found ${blocks.length}); the renderer only shows the first`
  }
  const mermaidErr = validateMermaid(blocks[0]!)
  if (mermaidErr) return mermaidErr
  return null
}

// Mermaid diagram types that do NOT support `click ... call navigate(...)`.
// Putting one inside these throws a parse error.
const NON_FLOWCHART_TYPES = new Set([
  'sequencediagram',
  'classdiagram',
  'statediagram',
  'statediagram-v2',
  'erdiagram',
  'mindmap',
  'gantt',
  'pie',
  'journey',
  'requirementdiagram',
  'timeline',
  'gitgraph',
  'sankey-beta',
  'sankey',
  'quadrantchart',
  'xychart-beta',
  'block-beta',
  'packet-beta',
  'kanban',
  'c4context',
  'c4container',
  'c4component',
  'c4dynamic',
  'c4deployment',
  'architecture-beta'
])

function detectDiagramType(source: string): string {
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('%%')) continue
    return line.split(/\s+/)[0]!.toLowerCase()
  }
  return ''
}

export function validateMermaid(source: string): string | null {
  const type = detectDiagramType(source)
  if (!type) return 'mermaid block is empty'

  const lines = source.split(/\r?\n/)
  const clickRe = /^\s*click\s+[A-Za-z0-9_-]+\s+call\s+navigate\(/

  if (NON_FLOWCHART_TYPES.has(type)) {
    for (let i = 0; i < lines.length; i++) {
      if (clickRe.test(lines[i]!)) {
        return (
          `\`click ... call navigate(...)\` is flowchart-only syntax — \`${type}\` diagrams don't support it (line ${i + 1}). ` +
          `Remove the click lines and put navigation links in the prose below the mermaid block as a bullet list.`
        )
      }
    }
  }

  // Flowcharts: catch a `{...}` shape token inside an unquoted `[...]` node
  // label — mermaid's parser misreads it as the start of a diamond shape
  // mid-bracket. Quoted labels (`["...{...}..."]`) are fine.
  if (!NON_FLOWCHART_TYPES.has(type)) {
    const labelRe = /\[([^\]\n]*)\]/g
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      labelRe.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = labelRe.exec(line)) !== null) {
        const inner = m[1]!
        const trimmed = inner.trim()
        const isQuoted =
          (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
          (trimmed.startsWith('`') && trimmed.endsWith('`') && trimmed.length >= 2)
        if (!isQuoted && inner.includes('{')) {
          return (
            `line ${i + 1}: a square-bracket node label contains \`{\` — mermaid will parse it as a diamond shape mid-bracket. ` +
            `Quote the whole label, e.g. \`["${inner.replace(/"/g, '\\"')}"]\`.`
          )
        }
      }
    }
  }

  return null
}

function extractMermaidBlocks(content: string): string[] {
  const lines = content.split(/\r?\n/)
  const blocks: string[] = []
  let fenceChar: string | null = null
  let fenceLength = 0
  let inMermaid = false
  let buf: string[] = []
  for (const line of lines) {
    const m = line.match(FENCE_OPEN_RE)
    if (m) {
      const seq = m[2]!
      const ch = seq[0]!
      const len = seq.length
      if (fenceChar === null) {
        fenceChar = ch
        fenceLength = len
        const info = m[3]!.trim().toLowerCase().split(/\s+/)[0]!
        inMermaid = info === 'mermaid' || info === '{mermaid}' || info.startsWith('{mermaid,')
        buf = []
        continue
      } else if (ch === fenceChar && len >= fenceLength && m[3]!.trim() === '') {
        if (inMermaid) blocks.push(buf.join('\n'))
        fenceChar = null
        fenceLength = 0
        inMermaid = false
        buf = []
        continue
      }
    }
    if (inMermaid) buf.push(line)
  }
  return blocks
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
