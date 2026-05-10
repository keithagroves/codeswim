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

function renderInline(text: string, onNavigate: (target: string) => void): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\))/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index))

    if (match[2]) {
      nodes.push(<code key={nodes.length}>{match[2]}</code>)
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

export function MarkdownProse({ source, onNavigate }: MarkdownProseProps): React.JSX.Element {
  const blocks = parseBlocks(source)

  return (
    <div className="diagram-prose">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'heading':
            return block.level <= 2 ? (
              <h3 key={index}>{renderInline(block.text, onNavigate)}</h3>
            ) : (
              <h4 key={index}>{renderInline(block.text, onNavigate)}</h4>
            )
          case 'paragraph':
            return <p key={index}>{renderInline(block.text, onNavigate)}</p>
          case 'unordered-list':
            return (
              <ul key={index}>
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{renderInline(item, onNavigate)}</li>
                ))}
              </ul>
            )
          case 'ordered-list':
            return (
              <ol key={index}>
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{renderInline(item, onNavigate)}</li>
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
      })}
    </div>
  )
}
