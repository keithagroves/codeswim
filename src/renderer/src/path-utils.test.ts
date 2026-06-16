import { describe, expect, it } from 'vitest'
import {
  basename,
  dirname,
  extname,
  joinPosix,
  normalize,
  parseTarget,
  relativeToRoot,
  resolveRelative,
  resolveWorkspacePath,
  toPosix
} from './path-utils'

describe('toPosix', () => {
  it('converts backslashes to forward slashes', () => {
    expect(toPosix('a\\b\\c.md')).toBe('a/b/c.md')
    expect(toPosix('C:\\Users\\me\\file.md')).toBe('C:/Users/me/file.md')
  })
})

describe('dirname', () => {
  it.each([
    ['a/b/c.md', 'a/b'],
    ['a.md', ''],
    ['/abs/path.md', '/abs'],
    ['/root.md', '/']
  ])('dirname(%s) -> %s', (input, expected) => {
    expect(dirname(input)).toBe(expected)
  })
})

describe('joinPosix', () => {
  it('joins non-empty parts and collapses repeated slashes', () => {
    expect(joinPosix('a', 'b', 'c.md')).toBe('a/b/c.md')
    expect(joinPosix('a/', '/b/', '/c.md')).toBe('a/b/c.md')
  })

  it('skips empty parts', () => {
    expect(joinPosix('', 'a', '', 'b')).toBe('a/b')
  })

  it('returns empty string when all parts are empty', () => {
    expect(joinPosix('', '')).toBe('')
  })
})

describe('normalize', () => {
  it('strips "." segments and collapses ".."', () => {
    expect(normalize('a/./b/../c')).toBe('a/c')
    expect(normalize('a/b/../../c')).toBe('c')
  })

  it('preserves leading ".." for relative paths', () => {
    expect(normalize('../a')).toBe('../a')
    expect(normalize('../../a/b')).toBe('../../a/b')
  })

  it('drops ".." segments that would escape an absolute root', () => {
    expect(normalize('/a/../../b')).toBe('/b')
    expect(normalize('/../../a')).toBe('/a')
  })

  it('handles redundant slashes', () => {
    expect(normalize('a//b///c')).toBe('a/b/c')
  })
})

describe('resolveRelative', () => {
  it('resolves sibling files', () => {
    expect(resolveRelative('docs/charge-flow.md', './refund.md')).toBe('docs/refund.md')
  })

  it('walks up the tree with ".."', () => {
    expect(resolveRelative('billing/flows/charge.md', '../shared/db.md')).toBe(
      'billing/shared/db.md'
    )
  })

  it('treats a target with no current dir as the target itself', () => {
    expect(resolveRelative('root.md', './sibling.md')).toBe('sibling.md')
  })

  it('handles current-dir prefix', () => {
    expect(resolveRelative('a/b/c.md', './d.md')).toBe('a/b/d.md')
  })
})

describe('basename + extname', () => {
  it('basename returns the trailing component', () => {
    expect(basename('a/b/c.md')).toBe('c.md')
    expect(basename('lonely.md')).toBe('lonely.md')
  })

  it('extname is lowercase and includes the dot', () => {
    expect(extname('a/b/c.MD')).toBe('.md')
    expect(extname('a/b/c.tsx')).toBe('.tsx')
  })

  it('extname returns empty string for dotfiles or no extension', () => {
    expect(extname('.gitignore')).toBe('')
    expect(extname('README')).toBe('')
  })
})

describe('relativeToRoot', () => {
  it('returns the path under the root', () => {
    expect(relativeToRoot('/Users/me/project', '/Users/me/project/src/main.ts')).toBe('src/main.ts')
  })

  it('returns empty string when the path equals the root', () => {
    expect(relativeToRoot('/Users/me/project', '/Users/me/project')).toBe('')
  })

  it('returns null for paths outside the root', () => {
    expect(relativeToRoot('/Users/me/project', '/Users/me/other/file.md')).toBeNull()
  })

  it('normalizes backslashes before comparing', () => {
    expect(relativeToRoot('C:\\proj', 'C:\\proj\\src\\app.tsx')).toBe('src/app.tsx')
  })

  it('does not confuse a prefix match for a directory match', () => {
    // /Users/me/proj-other looks like it starts with /Users/me/proj but isn't a child.
    expect(relativeToRoot('/Users/me/proj', '/Users/me/proj-other/file.md')).toBeNull()
  })

  it('handles a trailing slash on root', () => {
    expect(relativeToRoot('/Users/me/project/', '/Users/me/project/src/main.ts')).toBe(
      'src/main.ts'
    )
  })
})

describe('parseTarget', () => {
  it('returns the path unchanged when there is no fragment', () => {
    expect(parseTarget('./foo.ts')).toEqual({ path: './foo.ts', range: null })
  })

  it('parses a single-line ref', () => {
    expect(parseTarget('./foo.ts#L10')).toEqual({
      path: './foo.ts',
      range: { start: 10, end: 10 }
    })
  })

  it('parses an L10-L22 ref', () => {
    expect(parseTarget('./foo.ts#L10-L22')).toEqual({
      path: './foo.ts',
      range: { start: 10, end: 22 }
    })
  })

  it('parses the shorter L10-22 form', () => {
    expect(parseTarget('./foo.ts#L10-22')).toEqual({
      path: './foo.ts',
      range: { start: 10, end: 22 }
    })
  })

  it('falls back to no range when the fragment is unrecognized', () => {
    expect(parseTarget('./foo.ts#bad')).toEqual({ path: './foo.ts', range: null })
  })

  it('strips ?query suffixes from the path', () => {
    expect(parseTarget('./foo.ts?v=2#L5')).toEqual({
      path: './foo.ts',
      range: { start: 5, end: 5 }
    })
  })

  it('keeps the query out of the path when there is no fragment', () => {
    expect(parseTarget('./foo.ts?v=2')).toEqual({ path: './foo.ts', range: null })
  })

  it('rejects zero/negative line numbers', () => {
    expect(parseTarget('./foo.ts#L0')).toEqual({ path: './foo.ts', range: null })
  })

  it('normalizes an inverted range so end >= start', () => {
    // The implementation guards with Math.max(start, end>=start ? end : start).
    expect(parseTarget('./foo.ts#L20-L10')).toEqual({
      path: './foo.ts',
      range: { start: 20, end: 20 }
    })
  })

  it('accepts case-insensitive L', () => {
    expect(parseTarget('./foo.ts#l3-l4')).toEqual({
      path: './foo.ts',
      range: { start: 3, end: 4 }
    })
  })
})

describe('resolveWorkspacePath', () => {
  const files = [
    'overview.md',
    'architecture/http-routes.md',
    'architecture/services.md',
    'flows/generate-flow.md',
    '.codeswim/explanations/src/services/sandbox.ts.md',
    'src/services/sandbox.ts',
    'src/services/screener/orchestrator.ts'
  ]

  it('matches an exact root-relative path', () => {
    expect(resolveWorkspacePath('overview.md', files)).toBe('overview.md')
  })

  it('matches a bare filename via its unique basename', () => {
    expect(resolveWorkspacePath('http-routes.md', files)).toBe('architecture/http-routes.md')
  })

  it('matches a folder-prefixed path the root does not carry (basename fallback)', () => {
    // The agent wrote "server/overview.md" but the workspace root is server/.
    expect(resolveWorkspacePath('server/overview.md', files)).toBe('overview.md')
  })

  it('matches an explanation doc by its path suffix', () => {
    expect(resolveWorkspacePath('src/services/sandbox.ts.md', files)).toBe(
      '.codeswim/explanations/src/services/sandbox.ts.md'
    )
  })

  it('resolves a source file token (navigation maps it to its explanation)', () => {
    expect(resolveWorkspacePath('orchestrator.ts', files)).toBe(
      'src/services/screener/orchestrator.ts'
    )
  })

  it('strips a leading ./ and a trailing slash', () => {
    expect(resolveWorkspacePath('./overview.md', files)).toBe('overview.md')
    expect(resolveWorkspacePath('architecture/', files)).toBeNull() // directory → no file
  })

  it('returns null for a bare word with no separator or extension', () => {
    expect(resolveWorkspacePath('runCrossBeamFlow', files)).toBeNull()
  })

  it('returns null when nothing matches', () => {
    expect(resolveWorkspacePath('does/not/exist.md', files)).toBeNull()
  })

  it('returns null when a basename is ambiguous', () => {
    const dupes = ['frontend/overview.md', 'server/overview.md']
    expect(resolveWorkspacePath('overview.md', dupes)).toBeNull()
    // …but an exact path still wins over the ambiguity.
    expect(resolveWorkspacePath('server/overview.md', dupes)).toBe('server/overview.md')
  })
})
