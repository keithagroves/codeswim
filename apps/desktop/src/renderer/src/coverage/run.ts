// Renderer-side coverage runner. Walks the workspace tree (via the existing
// IPC), reads diagram contents, and runs the pure analyzeCoverage module.

import { joinPosix, toPosix } from '../path-utils'
import type { TreeNode } from '../store'
import { analyzeCoverage, type CoverageReport, type FileInfo } from '@codeswim/coverage'

const IGNORE_DIRS = new Set([
  // App-managed companion docs (explanations, board) — not part of the
  // author's diagram tree, so they must not count as orphan diagrams.
  '.codeswim',
  'node_modules',
  'dist',
  'out',
  'build',
  '.git',
  '.vscode',
  '.idea',
  '.DS_Store'
])

const IGNORE_BASENAMES = new Set([
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
  '.nvmrc',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock'
])

function flatten(nodes: TreeNode[], out: string[]): void {
  for (const node of nodes) {
    // Skip whole subtrees of ignored directories (cheap exact-name match;
    // listTree already prunes most of these, but defensive).
    if (node.kind === 'dir' && IGNORE_DIRS.has(node.name)) continue
    if (node.kind === 'file') {
      out.push(node.path)
    } else if (node.children) {
      flatten(node.children, out)
    }
  }
}

function basename(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? p : p.slice(i + 1)
}

export async function runCoverage(rootPath: string): Promise<CoverageReport> {
  const tree = await window.api.listTree(rootPath)
  const paths: string[] = []
  flatten(tree, paths)

  // analyzeCoverage only needs file *content* for diagrams (to extract links
  // and lint mermaid blocks). Non-md files just need their paths to exist
  // in the file set, so we hand them empty content to save IO.
  const root = toPosix(rootPath)
  const rootPrefix = root.endsWith('/') ? root : root + '/'
  const files: FileInfo[] = []
  for (const abs of paths) {
    const posix = toPosix(abs)
    const rel = posix.startsWith(rootPrefix) ? posix.slice(rootPrefix.length) : posix
    if (IGNORE_BASENAMES.has(basename(rel))) continue
    if (/\.(md|markdown)$/i.test(rel)) {
      try {
        const content = await window.api.readFile(joinPosix(root, rel))
        files.push({ path: rel, content })
      } catch {
        // unreadable diagram — skip
      }
    } else {
      files.push({ path: rel, content: '' })
    }
  }

  return analyzeCoverage(files)
}

// Formats a coverage report into a self-contained prompt the agent can act
// on. We let the agent pick how to fix each item rather than prescribing —
// the system prompt already encodes the MDD rules.
export function buildSyncPrompt(report: CoverageReport): string {
  const lines: string[] = []
  lines.push(
    'Run a diagram-sync pass on this workspace. The coverage tool found drift between the diagrams and the code. Fix each item below in place using `diagram_edit`; do not introduce unrelated changes.'
  )
  lines.push('')

  if (report.brokenLinks.length > 0) {
    lines.push(`## Broken links (${report.brokenLinks.length})`)
    lines.push('Each link in a diagram resolves to nothing. Either point at the right file or remove the link.')
    for (const b of report.brokenLinks) {
      lines.push(`- \`${b.sourceFile}:${b.line}:${b.column}\` — ${b.kind}(\`${b.target}\`)`)
    }
    lines.push('')
  }

  if (report.orphanDiagrams.length > 0) {
    lines.push(`## Orphan diagrams (${report.orphanDiagrams.length})`)
    lines.push('Not reachable from `overview.md`. Add a markdown link from `overview.md` (or another already-reachable diagram) so readers can find them.')
    for (const o of report.orphanDiagrams) lines.push(`- \`${o}\``)
    lines.push('')
  }

  if (report.uncoveredSources.length > 0) {
    lines.push(`## Uncovered source files (${report.uncoveredSources.length})`)
    lines.push('No diagram references these. Add a reference under the most relevant architecture doc\'s "Source" list (or create a new one if a genuinely new subsystem appeared).')
    for (const s of report.uncoveredSources) lines.push(`- \`${s}\``)
    lines.push('')
  }

  if (report.mermaidIssues.length > 0) {
    lines.push(`## Mermaid issues (${report.mermaidIssues.length})`)
    lines.push('These diagrams will not render. Fix the syntax.')
    for (const m of report.mermaidIssues) {
      lines.push(`- \`${m.sourceFile}:${m.line}\` — ${m.message}`)
    }
    lines.push('')
  }

  lines.push('Also: verify every node in every flowchart/graph diagram has a `click NodeId call navigate("...")` handler. Specific code/function nodes target their file (with a line ref when you can name the span); abstract nodes (states, errors, return values) target the relevant flow/ADR doc or `overview.md`. Add any missing handlers.')
  lines.push('')
  lines.push('When you\'re done, summarise what you changed in one short paragraph so I can re-run sync to confirm.')
  return lines.join('\n')
}
