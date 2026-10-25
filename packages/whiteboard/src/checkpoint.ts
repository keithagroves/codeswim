// The two hand-offs around a build: the brief that goes to the coding agent,
// and the checkpoint that comes back to the narrator for its walkthrough.

/** A `diagram_edit` the builder made: the file and its contents after the edit. */
export interface DiagramEdit {
  path: string
  after: string
}

export interface ChangedFile {
  file: string
  additions: number
  deletions: number
}

export interface Checkpoint {
  brief: string
  diagrams: DiagramEdit[]
  files: ChangedFile[]
  finalMessage: string
  /** The person stopped the build before it finished. */
  stopped?: boolean
  error?: string
  /**
   * The page beside the board, when one was open: outlined before the build,
   * reloaded and outlined after it. `changes` from diffPages (page.ts); empty
   * means nothing on it changed visibly.
   */
  page?: { url: string; changes: string[] }
}

/**
 * The prompt sent to the workspace's normal agent session. The harness takes
 * it from there: `diagram_edit` first (the plugin blocks code edits until
 * then), then code.
 */
export function builderPrompt(brief: string, pagesInWords: string, conversation = ''): string {
  const board = pagesInWords.trim()
  const talk = conversation.trim()
  return [
    'Build this design. The person and I agreed on it on the whiteboard, and they said yes to building it.',
    `<design-brief>\n${brief.trim()}\n</design-brief>`,
    board ? `<whiteboard>\n${board}\n</whiteboard>` : '',
    // So later questions in the chat ("why Postgres?") can be answered from
    // what was actually said, not just the brief.
    talk ? `<whiteboard-conversation>\n${talk}\n</whiteboard-conversation>` : '',
    'Work diagram-first, as always: create or update the relevant mermaid diagram(s) with diagram_edit before any code edit, then implement the change. Reuse the names from the whiteboard so the diagrams and the conversation match. When you are done, reply with a short summary of what you built and anything that differs from the brief.'
  ]
    .filter(Boolean)
    .join('\n\n')
}

const MERMAID = /^\s*(`{3,}|~{3,})\s*mermaid\b[^\n]*\n([\s\S]*?)^\s*\1\s*$/m

/** Just the mermaid source of a diagram file, for the walkthrough prompt. */
export function mermaidOf(markdown: string): string {
  const m = MERMAID.exec(markdown.replace(/\r\n/g, '\n'))
  return (m ? m[2] : markdown).trim()
}

const cap = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}\n…(truncated)`)

/** The <checkpoint> block for a walkthrough turn. */
export function formatCheckpoint(c: Checkpoint): string {
  const out: string[] = []
  if (c.stopped)
    out.push(
      'Status: the person stopped the build before it finished. Describe what got done so far.'
    )
  if (c.error) out.push(`Status: the build ended with an error: ${c.error}`)
  out.push(`Design brief:\n${c.brief.trim()}`)
  if (c.diagrams.length) {
    out.push(
      'Diagrams edited (path, then its mermaid source after the change):\n' +
        c.diagrams
          .slice(0, 6)
          .map((d) => `${d.path}\n${cap(mermaidOf(d.after), 1500)}`)
          .join('\n\n')
    )
  } else {
    out.push('Diagrams edited: none.')
  }
  if (c.files.length) {
    out.push(
      'Files changed:\n' +
        c.files
          .slice(0, 30)
          .map((f) => `- ${f.file} (+${f.additions} -${f.deletions})`)
          .join('\n')
    )
  } else {
    out.push('Files changed: none.')
  }
  if (c.finalMessage.trim())
    out.push(`The coding agent's final message:\n${cap(c.finalMessage.trim(), 1500)}`)
  if (c.page) {
    out.push(
      c.page.changes.length
        ? `The page beside the board (${c.page.url}), reloaded after the build. Measured changes:\n${c.page.changes.map((l) => `- ${l}`).join('\n')}`
        : `The page beside the board (${c.page.url}) was reloaded after the build, and nothing on it changed visibly.`
    )
  }
  return out.join('\n\n')
}

export interface ProjectDoc {
  path: string
  name?: string
  description?: string
}

/**
 * The <project> block: the workspace's real diagrams, so the narrator's
 * sketches use the project's own names and link boxes to real files.
 * `overview.md` first, then architecture, then the rest.
 */
export function projectSummary(docs: ProjectDoc[], limit = 40): string {
  if (!docs.length) return ''
  const rank = (p: string): number =>
    p === 'overview.md' ? 0 : p.startsWith('architecture/') ? 1 : p.startsWith('flows/') ? 2 : 3
  const sorted = [...docs].sort(
    (a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path)
  )
  const lines = sorted.slice(0, limit).map((d) => {
    const name = d.name?.trim()
    const desc = d.description?.trim().replace(/\s+/g, ' ').slice(0, 140)
    return `- ${d.path}${name ? `: ${name}` : ''}${desc ? ` (${desc})` : ''}`
  })
  const more = sorted.length > limit ? `\n…and ${sorted.length - limit} more` : ''
  return `Diagrams in this project (path: name (description)). Link boxes to these paths when they match:\n${lines.join('\n')}${more}`
}
