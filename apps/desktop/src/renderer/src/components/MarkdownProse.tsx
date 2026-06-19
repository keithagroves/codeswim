import type { MouseEvent, ReactNode } from 'react'

type MarkdownBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'unordered-list'; items: string[] }
  | { kind: 'ordered-list'; items: string[] }
  | { kind: 'code'; code: string }

interface MarkdownProseProps {
  source: string
  onNavigate(target: string): void
  // Heading levels in the source are renormalized to stay within this offset.
  // Default 2 → `# Foo` becomes h3, `## Foo` becomes h4 (the previous compact
  // behavior). Use 0 to render headings at their natural levels (h1, h2, …).
  headingOffset?: number
  // Optional: map an inline-code token to a real workspace file. When set,
  // code that resolves to a file is rendered as a clickable link (via
  // onNavigate); a token that doesn't resolve stays plain inline code. Used by
  // the chat panel so file paths the agent mentions are navigable.
  resolvePath?: (raw: string) => string | null
  // When true, a top-level `## Source` section (the bare file manifest at the
  // foot of an architecture doc) and its blocks fold into a collapsed
  // <details> so the prose isn't buried under a wall of file links. ReadView
  // opts in; chat/skills render everything inline.
  collapsibleSource?: boolean
}

// A `## Source` (or `## Source (…)`) heading whose body is just the file
// manifest — too much detail to show expanded by default.
function isSourceHeading(block: MarkdownBlock): boolean {
  return block.kind === 'heading' && block.level === 2 && /^source\b/i.test(block.text.trim())
}

function isFence(line: string): boolean {
  return /^([`~]{3,})/.test(line)
}

function parseBlocks(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  const lines = source.replace(/\r\n?/g, '\n').split('\n')

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim()) continue

    const fence = line.match(/^([`~]{3,})/)
    if (fence) {
      const marker = fence[1][0]
      const minLength = fence[1].length
      const codeLines: string[] = []
      index += 1
      while (index < lines.length) {
        const closing = lines[index].trim()
        if (
          closing.startsWith(marker.repeat(minLength)) &&
          closing.split('').every((ch) => ch === marker)
        ) {
          break
        }
        codeLines.push(lines[index])
        index += 1
      }
      blocks.push({ kind: 'code', code: codeLines.join('\n') })
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] })
      continue
    }

    const unordered = line.match(/^[-*+]\s+(.+)$/)
    if (unordered) {
      const items = [unordered[1]]
      while (index + 1 < lines.length) {
        const next = lines[index + 1].match(/^[-*+]\s+(.+)$/)
        if (!next) break
        items.push(next[1])
        index += 1
      }
      blocks.push({ kind: 'unordered-list', items })
      continue
    }

    const ordered = line.match(/^\d+[.)]\s+(.+)$/)
    if (ordered) {
      const items = [ordered[1]]
      while (index + 1 < lines.length) {
        const next = lines[index + 1].match(/^\d+[.)]\s+(.+)$/)
        if (!next) break
        items.push(next[1])
        index += 1
      }
      blocks.push({ kind: 'ordered-list', items })
      continue
    }

    const paragraphLines = [line.trim()]
    while (index + 1 < lines.length) {
      const next = lines[index + 1]
      if (
        !next.trim() ||
        /^(#{1,6})\s+/.test(next) ||
        /^[-*+]\s+/.test(next) ||
        /^\d+[.)]\s+/.test(next) ||
        isFence(next)
      ) {
        break
      }
      paragraphLines.push(next.trim())
      index += 1
    }
    blocks.push({ kind: 'paragraph', text: paragraphLines.join(' ') })
  }

  return blocks
}

function isExternalLink(target: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)
}

function renderInline(
  text: string,
  onNavigate: (target: string) => void,
  resolvePath?: (raw: string) => string | null
): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\))/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index))

    if (match[2]) {
      // Inline code. When a resolver is supplied (chat), code that names a real
      // workspace file becomes a navigable link; everything else stays plain.
      const codeText = match[2]
      const resolved = resolvePath?.(codeText) ?? null
      if (resolved) {
        nodes.push(
          <a
            key={nodes.length}
            className="prose-code-link"
            href={resolved}
            title={`Open ${resolved}`}
            onClick={(event: MouseEvent<HTMLAnchorElement>) => {
              event.preventDefault()
              onNavigate(resolved)
            }}
          >
            <code>{codeText}</code>
          </a>
        )
      } else {
        nodes.push(<code key={nodes.length}>{codeText}</code>)
      }
    } else if (match[3]) {
      nodes.push(<strong key={nodes.length}>{match[3]}</strong>)
    } else if (match[4] && match[5]) {
      const label = match[4]
      const target = match[5]
      const handleClick = (event: MouseEvent<HTMLAnchorElement>): void => {
        if (isExternalLink(target)) return
        event.preventDefault()
        onNavigate(target)
      }
      nodes.push(
        <a key={nodes.length} href={target} onClick={handleClick}>
          {label}
        </a>
      )
    }

    lastIndex = pattern.lastIndex
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))
  return nodes
}

function headingTag(level: number, offset: number): 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' {
  const target = Math.max(1, Math.min(6, level + offset))
  return (`h${target}`) as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
}

export function MarkdownProse({
  source,
  onNavigate,
  headingOffset = 2,
  resolvePath,
  collapsibleSource = false
}: MarkdownProseProps): React.JSX.Element {
  const blocks = parseBlocks(source)

  const renderBlock = (block: MarkdownBlock, index: number): ReactNode => {
    switch (block.kind) {
      case 'heading': {
        const Tag = headingTag(block.level, headingOffset)
        return <Tag key={index}>{renderInline(block.text, onNavigate, resolvePath)}</Tag>
      }
      case 'paragraph':
        return <p key={index}>{renderInline(block.text, onNavigate, resolvePath)}</p>
      case 'unordered-list':
        return (
          <ul key={index}>
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex}>{renderInline(item, onNavigate, resolvePath)}</li>
            ))}
          </ul>
        )
      case 'ordered-list':
        return (
          <ol key={index}>
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex}>{renderInline(item, onNavigate, resolvePath)}</li>
            ))}
          </ol>
        )
      case 'code':
        return (
          <pre key={index}>
            <code>{block.code}</code>
          </pre>
        )
    }
  }

  const rendered: ReactNode[] = []
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (collapsibleSource && isSourceHeading(block)) {
      // Fold this heading plus everything under it (including any level-3
      // subsections) until the next level-≤2 heading into a collapsed details.
      const body: ReactNode[] = []
      let cursor = index + 1
      while (cursor < blocks.length) {
        const next = blocks[cursor]
        if (next.kind === 'heading' && next.level <= 2) break
        body.push(renderBlock(next, cursor))
        cursor += 1
      }
      rendered.push(
        <details key={index} className="prose-source-details">
          <summary>{renderInline(block.text, onNavigate, resolvePath)}</summary>
          {body}
        </details>
      )
      index = cursor - 1
      continue
    }
    rendered.push(renderBlock(block, index))
  }

  return <div className="diagram-prose">{rendered}</div>
}
