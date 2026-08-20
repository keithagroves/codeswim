import { describe, expect, it } from 'vitest'
import { assertRelativeWorkspacePath } from './path-guard'

describe('assertRelativeWorkspacePath', () => {
  it('accepts an ordinary relative path', () => {
    expect(() => assertRelativeWorkspacePath('architecture/auth.md')).not.toThrow()
    expect(() => assertRelativeWorkspacePath('overview.md')).not.toThrow()
  })

  it('rejects an absolute POSIX path', () => {
    expect(() => assertRelativeWorkspacePath('/etc/passwd')).toThrow(/relative/)
  })

  it('rejects a Windows-style absolute path', () => {
    expect(() => assertRelativeWorkspacePath('C:\\Windows\\System32')).toThrow(/relative/)
  })

  it('rejects any ".." segment, even buried mid-path', () => {
    expect(() => assertRelativeWorkspacePath('../secret.md')).toThrow(/\.\./)
    expect(() => assertRelativeWorkspacePath('a/../../secret.md')).toThrow(/\.\./)
    expect(() => assertRelativeWorkspacePath('a/b/../c.md')).toThrow(/\.\./)
  })

  it('rejects an empty or non-string value', () => {
    expect(() => assertRelativeWorkspacePath('')).toThrow()
    expect(() => assertRelativeWorkspacePath(undefined)).toThrow()
    expect(() => assertRelativeWorkspacePath(42)).toThrow()
  })
})
