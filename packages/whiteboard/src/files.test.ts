import { describe, expect, it } from 'vitest'
import { FILE_LIMITS, formatFiles, mentionedPaths } from './files'

const PATHS = [
  'overview.md',
  'src/auth/session.ts',
  'src/auth/login.ts',
  'src/billing/session.ts',
  'src/billing/invoice.ts',
  'package.json',
  'README.md'
]

describe('mentionedPaths', () => {
  it('finds exact paths, file names and folders', () => {
    expect(mentionedPaths('What does src/auth/login.ts do?', PATHS).files).toEqual([
      'src/auth/login.ts'
    ])
    expect(mentionedPaths('explain ./package.json please', PATHS).files).toEqual(['package.json'])
    // A name that exists twice brings both, shortest path first.
    expect(mentionedPaths('how does session.ts work?', PATHS).files).toEqual([
      'src/auth/session.ts',
      'src/billing/session.ts'
    ])
    expect(mentionedPaths('walk me through src/billing/', PATHS).folders).toEqual([
      { path: 'src/billing', entries: ['src/billing/session.ts', 'src/billing/invoice.ts'] }
    ])
    // A trailing path matches wherever it lives.
    expect(mentionedPaths('look at auth/login.ts', PATHS).files).toEqual(['src/auth/login.ts'])
  })

  it('ignores plain words and names that are not in the workspace', () => {
    expect(mentionedPaths('how does auth work?', PATHS)).toEqual({ files: [], folders: [] })
    expect(mentionedPaths('what about payments.ts?', PATHS)).toEqual({ files: [], folders: [] })
    expect(mentionedPaths('e.g. this', PATHS).files).toEqual([])
  })

  it('reads at most a few files', () => {
    const q = 'compare overview.md, README.md, package.json and src/auth/login.ts'
    expect(mentionedPaths(q, PATHS).files).toHaveLength(FILE_LIMITS.files)
  })
})

describe('formatFiles', () => {
  it('cuts long files and keeps the total bounded', () => {
    const big = 'x'.repeat(FILE_LIMITS.perFile + 500)
    const text = formatFiles(
      [
        { path: 'a.ts', text: big },
        { path: 'b.ts', text: big },
        { path: 'c.ts', text: big }
      ],
      [{ path: 'src', entries: ['src/a.ts'] }]
    )
    expect(text).toContain('--- a.ts\n')
    expect(text).toContain(`…(cut at ${FILE_LIMITS.perFile} characters)`)
    expect(text.length).toBeLessThan(FILE_LIMITS.total + 500)
    expect(text).toContain('--- src/ (folder)\nsrc/a.ts')
  })
})
