// Heuristic mermaid linter. Mirrors the validator in codeswim's harness
// plugin (src/harness/tool/diagram-edit.ts) — keep the two in sync.
//
// Catches the specific failure patterns we've seen in practice:
//   - `click ... call navigate(...)` inside non-flowchart diagrams (which
//     mermaid's parser rejects with a cryptic "Expecting SOLID_ARROW…" error)
//   - `{...}` shape tokens inside an unquoted `[...]` node label (mermaid
//     misreads it as the start of a diamond shape mid-bracket)
//
// Not a full parse — that needs the mermaid runtime + DOM. This catches
// the bugs the agent actually generates, with zero new dependencies.

import type { FileInfo } from './coverage'

export interface MermaidIssue {
  sourceFile: string
  line: number // 1-indexed, relative to the file
  message: string
}

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

const FENCE_OPEN_RE = /^( {0,3})(`{3,}|~{3,})([^\r\n]*)/

interface MermaidBlock {
  source: string
  startLine: number // 1-indexed line in the file of the first content line
}

function extractMermaidBlocks(file: FileInfo): MermaidBlock[] {
  const lines = file.content.split(/\r?\n/)
  const blocks: MermaidBlock[] = []
  let fenceChar: string | null = null
  let fenceLength = 0
  let inMermaid = false
  let buf: string[] = []
  let blockStart = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(FENCE_OPEN_RE)
    if (m) {
      const seq = m[2]
      const ch = seq[0]
      const len = seq.length
      if (fenceChar === null) {
        fenceChar = ch
        fenceLength = len
        const info = m[3].trim().toLowerCase().split(/\s+/)[0]
        inMermaid = info === 'mermaid' || info === '{mermaid}' || info.startsWith('{mermaid,')
        buf = []
        blockStart = i + 2 // first content line after the fence
        continue
      } else if (ch === fenceChar && len >= fenceLength && m[3].trim() === '') {
        if (inMermaid) blocks.push({ source: buf.join('\n'), startLine: blockStart })
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

function detectDiagramType(source: string): string {
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('%%')) continue
    return line.split(/\s+/)[0].toLowerCase()
  }
  return ''
}

function lintBlock(file: FileInfo, block: MermaidBlock): MermaidIssue[] {
  const issues: MermaidIssue[] = []
  const type = detectDiagramType(block.source)
  if (!type) return issues

  const lines = block.source.split(/\r?\n/)
  const clickRe = /^\s*click\s+[A-Za-z0-9_-]+\s+call\s+navigate\(/

  if (NON_FLOWCHART_TYPES.has(type)) {
    for (let i = 0; i < lines.length; i++) {
      if (clickRe.test(lines[i])) {
        issues.push({
          sourceFile: file.path,
          line: block.startLine + i,
          message:
            `\`click ... call navigate(...)\` is flowchart-only — \`${type}\` does not support it. ` +
            `Move navigation to a prose bullet list under the mermaid block.`
        })
      }
    }
  } else {
    const labelRe = /\[([^\]\n]*)\]/g
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      labelRe.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = labelRe.exec(line)) !== null) {
        const inner = m[1]
        const trimmed = inner.trim()
        const isQuoted =
          (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
          (trimmed.startsWith('`') && trimmed.endsWith('`') && trimmed.length >= 2)
        if (!isQuoted && inner.includes('{')) {
          issues.push({
            sourceFile: file.path,
            line: block.startLine + i,
            message:
              `unquoted square-bracket label contains \`{\` — mermaid parses it as a diamond start. ` +
              `Quote the label: \`["${inner.replace(/"/g, '\\"')}"]\`.`
          })
        }
      }
    }
  }

  return issues
}

export function lintMermaid(files: FileInfo[]): MermaidIssue[] {
  const all: MermaidIssue[] = []
  for (const file of files) {
    if (!/\.(md|markdown)$/i.test(file.path)) continue
    for (const block of extractMermaidBlocks(file)) {
      all.push(...lintBlock(file, block))
    }
  }
  return all
}
