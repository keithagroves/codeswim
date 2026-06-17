import { describe, expect, it } from 'vitest'
import { isMarkdownPath, parseFrontmatter, splitFrontmatter } from './skill-frontmatter'

describe('isMarkdownPath', () => {
  it.each([
    ['SKILL.md', true],
    ['rules/install.md', true],
    ['README.MD', true],
    ['notes.markdown', true],
    ['system.txt', true],
    ['script.sh', false],
    ['config.json', false],
    ['no-extension', false]
  ])('isMarkdownPath(%s) = %s', (path, expected) => {
    expect(isMarkdownPath(path)).toBe(expected)
  })
})

describe('splitFrontmatter', () => {
  it('returns the whole source as body when no frontmatter present', () => {
    const result = splitFrontmatter('# Just a body\n\nNo metadata here.')
    expect(result.frontmatter).toBe('')
    expect(result.body).toBe('# Just a body\n\nNo metadata here.')
  })

  it('splits a well-formed frontmatter block', () => {
    const source = '---\nname: foo\ndescription: bar\n---\n# Body\n\ntext'
    const { frontmatter, body } = splitFrontmatter(source)
    expect(frontmatter).toBe('name: foo\ndescription: bar')
    expect(body).toBe('# Body\n\ntext')
  })

  it('handles CRLF line endings', () => {
    const source = '---\r\nname: foo\r\n---\r\n# Body'
    const { frontmatter, body } = splitFrontmatter(source)
    expect(frontmatter).toBe('name: foo')
    expect(body).toBe('# Body')
  })

  it('does not treat horizontal rules as frontmatter', () => {
    // Frontmatter must START the document — a `---` in the middle of prose
    // is just a horizontal rule.
    const source = 'Some prose.\n\n---\n\nMore prose.'
    const { frontmatter, body } = splitFrontmatter(source)
    expect(frontmatter).toBe('')
    expect(body).toBe(source)
  })
})

describe('parseFrontmatter', () => {
  it('returns empty object for empty input', () => {
    expect(parseFrontmatter('')).toEqual({})
  })

  it('parses single-line name and description', () => {
    const fm = 'name: my-skill\ndescription: Does a thing'
    expect(parseFrontmatter(fm)).toEqual({
      name: 'my-skill',
      description: 'Does a thing'
    })
  })

  it('strips surrounding single and double quotes', () => {
    expect(parseFrontmatter('name: "quoted"')).toEqual({ name: 'quoted' })
    expect(parseFrontmatter("description: 'also quoted'")).toEqual({
      description: 'also quoted'
    })
  })

  it('joins block-scalar descriptions (`description: |`)', () => {
    const fm = [
      'name: firecrawl',
      'description: |',
      '  First sentence.',
      '  Second sentence.'
    ].join('\n')
    expect(parseFrontmatter(fm)).toEqual({
      name: 'firecrawl',
      description: 'First sentence. Second sentence.'
    })
  })

  it('handles folded scalars (`description: >`)', () => {
    const fm = ['description: >', '  Long', '  description'].join('\n')
    expect(parseFrontmatter(fm).description).toBe('Long description')
  })

  it('handles chomping indicators (`|-`, `>-`)', () => {
    expect(parseFrontmatter('description: |-\n  one\n  two').description).toBe('one two')
    expect(parseFrontmatter('description: >-\n  one\n  two').description).toBe('one two')
  })

  it('ignores keys other than name/description', () => {
    const fm = ['name: x', 'tags: [a, b]', 'allowed-tools:', '  - Bash(*)'].join('\n')
    const result = parseFrontmatter(fm)
    expect(result.name).toBe('x')
    expect(result.description).toBeUndefined()
    // tags / allowed-tools are deliberately dropped — the editor still has
    // the raw frontmatter for anything we don't surface.
  })

  it('skips malformed lines without throwing', () => {
    const fm = 'name: foo\n: missing key\nweird input\ndescription: bar'
    expect(parseFrontmatter(fm)).toEqual({ name: 'foo', description: 'bar' })
  })
})
