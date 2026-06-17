// Helpers for parsing the bits of YAML frontmatter the Skills view cares
// about. Kept tiny on purpose — we don't try to be a real YAML parser; we
// just need `name` and `description` (including block-scalar forms used by
// Anthropic-style skills).

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.txt'])

export function isMarkdownPath(p: string): boolean {
  const idx = p.lastIndexOf('.')
  if (idx < 0) return false
  return MARKDOWN_EXTENSIONS.has(p.slice(idx).toLowerCase())
}

export interface SplitFrontmatter {
  frontmatter: string
  body: string
}

// Returns the YAML block (without delimiters) and the body that follows.
// If there's no leading `---` block, returns the entire source as `body`.
export function splitFrontmatter(source: string): SplitFrontmatter {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return { frontmatter: '', body: source }
  return { frontmatter: match[1], body: source.slice(match[0].length) }
}

export interface ParsedFrontmatter {
  name?: string
  description?: string
}

// Extracts `name:` and `description:` from a YAML frontmatter block.
// Handles single-line values (quoted or not) plus block scalars
// (`description: |` / `>` / `|-` / `>-`) by collecting indented
// continuation lines. Other keys are ignored — the editor still has the
// raw source for anything we don't surface.
export function parseFrontmatter(fm: string): ParsedFrontmatter {
  if (!fm) return {}
  const out: ParsedFrontmatter = {}
  const lines = fm.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(/^(\w[\w-]*):\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    const value = m[2].trim()
    const isBlockScalar =
      value === '|' || value === '>' || value === '|-' || value === '>-'
    let resolved = value.replace(/^['"]|['"]$/g, '')
    if (isBlockScalar) {
      const parts: string[] = []
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) {
        parts.push(lines[i + 1].trim())
        i += 1
      }
      resolved = parts.join(' ')
    }
    if (key === 'name') out.name = resolved
    else if (key === 'description') out.description = resolved
  }
  return out
}
