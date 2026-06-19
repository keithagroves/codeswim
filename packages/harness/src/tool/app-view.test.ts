import { describe, expect, it } from 'vitest'
import { formatAppState, validateOpenFilePath, validateViewName } from './app-view'

describe('validateOpenFilePath', () => {
  it('accepts a relative posix path', () => {
    expect(validateOpenFilePath('architecture/auth.md')).toBeNull()
  })
  it('rejects empty, absolute, and traversal paths', () => {
    expect(validateOpenFilePath('')).toMatch(/required/)
    expect(validateOpenFilePath('/etc/passwd')).toMatch(/relative/)
    expect(validateOpenFilePath('../secrets.md')).toMatch(/\.\./)
    expect(validateOpenFilePath(42)).toMatch(/required/)
  })
})

describe('validateViewName', () => {
  it('accepts the two known views', () => {
    expect(validateViewName('navigator')).toBeNull()
    expect(validateViewName('kanban')).toBeNull()
  })
  it('rejects anything else', () => {
    expect(validateViewName('output')).toMatch(/navigator/)
  })
})

describe('formatAppState', () => {
  it('reports no state when nothing is published', () => {
    expect(formatAppState(null)).toMatch(/No app state/)
  })
  it('handles unparseable snapshots gracefully', () => {
    expect(formatAppState('{not json')).toMatch(/unavailable/)
  })
  it('summarizes an open diagram in the navigator', () => {
    const out = formatAppState(
      JSON.stringify({
        workspaceView: 'navigator',
        currentFile: 'flows/login.md',
        currentDocumentPath: 'flows/login.md',
        view: 'diagram',
        breadcrumbs: ['overview.md', 'flows/login.md'],
        runningScript: null
      })
    )
    expect(out).toContain('diagram navigator')
    expect(out).toContain('flows/login.md')
    expect(out).toContain('diagram/doc')
    expect(out).toContain('overview.md → flows/login.md')
  })
  it('names the companion doc for a source file', () => {
    const out = formatAppState(
      JSON.stringify({
        workspaceView: 'navigator',
        currentFile: 'src/server.ts',
        currentDocumentPath: '.codeswim/explanations/src/server.ts.md',
        view: 'read',
        breadcrumbs: [],
        runningScript: 'dev'
      })
    )
    expect(out).toContain('source file')
    expect(out).toContain('Companion doc: .codeswim/explanations/src/server.ts.md')
    expect(out).toContain('Running script: dev')
  })
  it('reports the kanban board', () => {
    const out = formatAppState(
      JSON.stringify({
        workspaceView: 'kanban',
        currentFile: null,
        currentDocumentPath: null,
        view: 'diagram',
        breadcrumbs: [],
        runningScript: null
      })
    )
    expect(out).toContain('Kanban board')
  })
})
