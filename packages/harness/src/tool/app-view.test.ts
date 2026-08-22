import { describe, expect, it } from 'vitest'
import { formatAppState, validateOpenFilePath } from './app-view'

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

describe('formatAppState', () => {
  it('reports no state when nothing is published', () => {
    expect(formatAppState(null)).toMatch(/No app state/)
  })
  it('handles unparseable snapshots gracefully', () => {
    expect(formatAppState('{not json')).toMatch(/unavailable/)
  })
  it('degrades gracefully on valid JSON that matches neither known shape', () => {
    expect(formatAppState('{}')).toMatch(/unexpected shape/)
    expect(formatAppState('{"foo":1}')).toMatch(/unexpected shape/)
    expect(formatAppState('[1,2,3]')).toMatch(/unexpected shape/)
    expect(formatAppState('"just a string"')).toMatch(/unexpected shape/)
    expect(formatAppState('42')).toMatch(/unexpected shape/)
  })
  it('(legacy shape) summarizes an open diagram in the navigator', () => {
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
  it('(legacy shape) names the companion doc for a source file', () => {
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
  it('(legacy shape) reports the kanban board', () => {
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

describe('formatAppState (ScreenContextV2)', () => {
  it('summarizes the navigator, including diagram render errors', () => {
    const out = formatAppState(
      JSON.stringify({
        version: 2,
        workspaceView: 'navigator',
        focus: { surface: 'navigator', itemId: 'flows/login.md' },
        runningScript: null,
        surfaces: {
          navigator: {
            currentFile: 'flows/login.md',
            currentDocumentPath: 'flows/login.md',
            view: 'diagram',
            breadcrumbs: ['overview.md', 'flows/login.md'],
            diagramErrors: ['Parse error on line 3']
          }
        }
      })
    )
    expect(out).toContain('diagram navigator')
    expect(out).toContain('flows/login.md')
    expect(out).toContain('overview.md → flows/login.md')
    expect(out).toContain('Diagram render errors: Parse error on line 3')
  })

  it('reports the open kanban card and running-via-Run-all cards', () => {
    const out = formatAppState(
      JSON.stringify({
        version: 2,
        workspaceView: 'kanban',
        focus: { surface: 'kanban', itemId: 'card-1' },
        runningScript: null,
        surfaces: {
          kanban: {
            columns: [
              { id: 'backlog', name: 'Backlog', cardCount: 2 },
              { id: 'done', name: 'Done', cardCount: 1 }
            ],
            openCardId: 'card-1',
            runningCardIds: ['card-2', 'card-3']
          }
        }
      })
    )
    expect(out).toContain('Kanban board')
    expect(out).toContain('Backlog (2)')
    expect(out).toContain('Open card: card-1')
    expect(out).toContain('Cards running via "Run all": card-2, card-3')
  })

  it('reports a diff surface', () => {
    const out = formatAppState(
      JSON.stringify({
        version: 2,
        workspaceView: 'navigator',
        focus: { surface: 'diff', itemId: 'src/foo.ts' },
        runningScript: null,
        surfaces: { diff: { path: 'src/foo.ts', hunkCount: 3 } }
      })
    )
    expect(out).toContain('Diff open: src/foo.ts — 3 hunks')
  })

  it('reports a terminal surface only when focused there', () => {
    const out = formatAppState(
      JSON.stringify({
        version: 2,
        workspaceView: 'navigator',
        focus: { surface: 'terminal', itemId: '2' },
        runningScript: null,
        surfaces: { terminal: { tabCount: 2, activeTabId: '2', activeTabLabel: 'Terminal 2' } }
      })
    )
    expect(out).toContain('Terminal: 2 tabs, active "Terminal 2"')
  })

  it('reports the script-output tail when focused there, and just the name otherwise', () => {
    const focused = formatAppState(
      JSON.stringify({
        version: 2,
        workspaceView: 'navigator',
        focus: { surface: 'script-output', itemId: 'dev' },
        runningScript: { name: 'dev', status: 'running' },
        surfaces: {
          scriptOutput: { name: 'dev', status: 'running', tail: ['line one', 'line two'] }
        }
      })
    )
    expect(focused).toContain('Script output (dev, running):')
    expect(focused).toContain('line one')
    expect(focused).toContain('line two')

    const unfocused = formatAppState(
      JSON.stringify({
        version: 2,
        workspaceView: 'navigator',
        focus: { surface: 'navigator', itemId: 'overview.md' },
        runningScript: { name: 'dev', status: 'running' },
        surfaces: {}
      })
    )
    expect(unfocused).toContain('Running script: dev')
    expect(unfocused).not.toContain('Script output')
  })

  it('reports "no card open" / "no file open" when nothing is', () => {
    const out = formatAppState(
      JSON.stringify({
        version: 2,
        workspaceView: 'kanban',
        focus: { surface: 'kanban', itemId: null },
        runningScript: null,
        surfaces: { kanban: { columns: [], openCardId: null, runningCardIds: [] } }
      })
    )
    expect(out).toContain('No card is open.')
  })
})
