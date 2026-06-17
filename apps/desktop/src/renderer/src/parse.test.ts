import { describe, expect, it } from 'vitest'
import { parseMarkdown } from './parse'

describe('parseMarkdown / frontmatter', () => {
  it('extracts name/description/tags', () => {
    const doc = parseMarkdown(
      [
        '---',
        'name: API surface',
        'description: HTTP routes',
        'tags: [api, http]',
        '---',
        '',
        'Some prose.'
      ].join('\n')
    )
    expect(doc.frontmatter.name).toBe('API surface')
    expect(doc.frontmatter.description).toBe('HTTP routes')
    expect(doc.frontmatter.tags).toEqual(['api', 'http'])
    expect(doc.prose).toBe('Some prose.')
    expect(doc.mermaidBlocks).toEqual([])
  })

  it('returns empty frontmatter when the document does not open with ---', () => {
    const doc = parseMarkdown('Just prose.\nNo frontmatter here.\n')
    expect(doc.frontmatter).toEqual({})
    expect(doc.prose).toBe('Just prose.\nNo frontmatter here.')
  })

  it('treats unterminated frontmatter as no frontmatter', () => {
    const doc = parseMarkdown('---\nname: Stuck\n\nNo closing fence here.')
    expect(doc.frontmatter).toEqual({})
    // Body remains intact (leading --- and all).
    expect(doc.prose.startsWith('---')).toBe(true)
  })

  it('survives malformed YAML by falling back to empty frontmatter', () => {
    const doc = parseMarkdown('---\nname: [unterminated\n---\nprose\n')
    expect(doc.frontmatter).toEqual({})
    expect(doc.prose).toBe('prose')
  })
})

describe('parseMarkdown / mermaid blocks', () => {
  it('extracts a single mermaid block', () => {
    const doc = parseMarkdown(
      ['# Title', '', '```mermaid', 'flowchart TD', '  A --> B', '```', '', 'tail prose'].join('\n')
    )
    expect(doc.mermaidBlocks).toEqual(['flowchart TD\n  A --> B'])
    expect(doc.prose).toBe('# Title\n\n\ntail prose')
  })

  it('extracts multiple mermaid blocks in order', () => {
    const doc = parseMarkdown(
      ['```mermaid', 'graph A', '```', 'middle', '```mermaid', 'graph B', '```'].join('\n')
    )
    expect(doc.mermaidBlocks).toEqual(['graph A', 'graph B'])
    expect(doc.prose).toBe('middle')
  })

  it('ignores non-mermaid code fences', () => {
    const doc = parseMarkdown(
      ['```ts', "console.log('hi')", '```', '', '```mermaid', 'flowchart TD', '```'].join('\n')
    )
    expect(doc.mermaidBlocks).toEqual(['flowchart TD'])
    // The ts fence stays in prose so the markdown view can still show it.
    expect(doc.prose).toContain("console.log('hi')")
  })

  it('supports tilde fences', () => {
    const doc = parseMarkdown(['~~~mermaid', 'flowchart TD', '~~~'].join('\n'))
    expect(doc.mermaidBlocks).toEqual(['flowchart TD'])
  })

  it('supports fences longer than three backticks and requires matching length to close', () => {
    // A 3-backtick line inside a 4-backtick block must NOT close it.
    const doc = parseMarkdown(
      ['````mermaid', 'flowchart TD', '```', 'still inside', '````'].join('\n')
    )
    expect(doc.mermaidBlocks).toEqual(['flowchart TD\n```\nstill inside'])
  })

  it('does not mix marker types when closing a fence', () => {
    // A tilde line should NOT close a backtick fence — the body should
    // continue until EOF and the parser drops it as the unclosed block.
    const doc = parseMarkdown(['```mermaid', 'flowchart TD', '~~~'].join('\n'))
    expect(doc.mermaidBlocks).toEqual(['flowchart TD\n~~~'])
  })

  it('handles CRLF line endings', () => {
    const raw =
      '---\r\nname: CRLF doc\r\n---\r\nintro\r\n\r\n```mermaid\r\nflowchart TD\r\n  A --> B\r\n```\r\n'
    const doc = parseMarkdown(raw)
    expect(doc.frontmatter.name).toBe('CRLF doc')
    expect(doc.mermaidBlocks).toEqual(['flowchart TD\n  A --> B'])
    expect(doc.prose).toBe('intro')
  })

  it('recognizes attribute-style mermaid info strings', () => {
    const doc = parseMarkdown(['```{mermaid}', 'flowchart TD', '```'].join('\n'))
    expect(doc.mermaidBlocks).toEqual(['flowchart TD'])

    const doc2 = parseMarkdown(['```{mermaid, theme=dark}', 'flowchart TD', '```'].join('\n'))
    expect(doc2.mermaidBlocks).toEqual(['flowchart TD'])
  })

  it('rejects look-alike languages that merely start with "mermaid"', () => {
    const doc = parseMarkdown(['```mermaidx', 'not a diagram', '```'].join('\n'))
    expect(doc.mermaidBlocks).toEqual([])
  })

  it('keeps the rest of the document as prose if a mermaid fence is unclosed', () => {
    const doc = parseMarkdown(['intro', '```mermaid', 'flowchart TD', '  A --> B'].join('\n'))
    // The unterminated block still captures whatever followed up to EOF.
    expect(doc.mermaidBlocks).toEqual(['flowchart TD\n  A --> B'])
    expect(doc.prose).toBe('intro')
  })
})
