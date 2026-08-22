import { describe, expect, it } from 'vitest'
import type { AppState } from '../store'
import { composeScreenContext } from './compose-screen-context'

function baseState(overrides: Partial<AppState> = {}): AppState {
  return {
    rootPath: '/root',
    workspaceView: 'navigator',
    currentFile: 'overview.md',
    currentDocumentPath: 'overview.md',
    view: 'diagram',
    breadcrumbs: ['overview.md'],
    diffPath: null,
    diffContent: null,
    activeSection: 'files',
    activeAgentTabId: null,
    runningScript: null,
    ...overrides
  } as AppState
}

describe('composeScreenContext', () => {
  it('always stamps version 2 and the current workspaceView', () => {
    const out = composeScreenContext(baseState(), {})
    expect(out.version).toBe(2)
    expect(out.workspaceView).toBe('navigator')
  })

  it('navigator: focuses the current file and reports no diagram errors when none are registered', () => {
    const out = composeScreenContext(baseState(), {})
    expect(out.focus).toEqual({ surface: 'navigator', itemId: 'overview.md' })
    expect(out.surfaces.navigator).toEqual({
      currentFile: 'overview.md',
      currentDocumentPath: 'overview.md',
      view: 'diagram',
      breadcrumbs: ['overview.md'],
      diagramErrors: []
    })
  })

  it('navigator: aggregates diagram errors from every navigator:diagram:* block', () => {
    const out = composeScreenContext(baseState(), {
      'navigator:diagram:0': { error: 'bad syntax' },
      'navigator:diagram:1': { error: 'unknown node' },
      'kanban': { columns: [], openCardId: null, runningCardIds: [] } // unrelated block, ignored
    })
    expect(out.surfaces.navigator?.diagramErrors.sort()).toEqual(['bad syntax', 'unknown node'])
  })

  it('kanban: focuses the open card and surfaces the kanban block verbatim', () => {
    const kanbanBlock = {
      columns: [{ id: 'backlog', name: 'Backlog', cardCount: 3 }],
      openCardId: 'card-1',
      runningCardIds: ['card-2']
    }
    const out = composeScreenContext(baseState({ workspaceView: 'kanban' }), { kanban: kanbanBlock })
    expect(out.focus).toEqual({ surface: 'kanban', itemId: 'card-1' })
    expect(out.surfaces.kanban).toEqual(kanbanBlock)
    // Not the active surface, so no navigator block.
    expect(out.surfaces.navigator).toBeUndefined()
  })

  it('agents: focuses the active agent tab', () => {
    const out = composeScreenContext(
      baseState({ workspaceView: 'agents', activeAgentTabId: 'tab-1' }),
      {}
    )
    expect(out.focus).toEqual({ surface: 'agents', itemId: 'tab-1' })
  })

  it('diff: wins focus over workspaceView/activeSection, and counts hunks', () => {
    const diffContent = '@@ -1,2 +1,3 @@\nfoo\n@@ -10,1 +10,1 @@\nbar'
    const out = composeScreenContext(
      baseState({
        view: 'diff',
        diffPath: 'src/foo.ts',
        diffContent,
        workspaceView: 'kanban',
        activeSection: 'terminal'
      }),
      { kanban: { columns: [], openCardId: null, runningCardIds: [] } }
    )
    expect(out.focus).toEqual({ surface: 'diff', itemId: 'src/foo.ts' })
    expect(out.surfaces.diff).toEqual({ path: 'src/foo.ts', hunkCount: 2 })
  })

  it('terminal: focuses the active tab from the terminal:terminal block', () => {
    const terminalBlock = { tabCount: 2, activeTabId: 't2', activeTabLabel: 'Terminal 2' }
    const out = composeScreenContext(baseState({ activeSection: 'terminal' }), {
      'terminal:terminal': terminalBlock
    })
    expect(out.focus).toEqual({ surface: 'terminal', itemId: 't2' })
    expect(out.surfaces.terminal).toEqual(terminalBlock)
  })

  it('terminal (claude section): reads terminal:claude, not terminal:terminal', () => {
    const claudeBlock = { tabCount: 1, activeTabId: 'c1', activeTabLabel: 'Claude 1' }
    const out = composeScreenContext(baseState({ activeSection: 'claude' }), {
      'terminal:terminal': { tabCount: 5, activeTabId: 'wrong', activeTabLabel: 'wrong' },
      'terminal:claude': claudeBlock
    })
    expect(out.focus.itemId).toBe('c1')
    expect(out.surfaces.terminal).toEqual(claudeBlock)
  })

  it('script-output: focused view publishes a bounded, ANSI-stripped tail; runningScript is always present regardless of focus', () => {
    const runningScript = {
      name: 'dev',
      status: 'running' as const,
      exitCode: null,
      signal: null,
      output: '[32mline one[39m\nline two',
      startedAt: 0
    }
    const focused = composeScreenContext(baseState({ view: 'output', runningScript }), {})
    expect(focused.focus).toEqual({ surface: 'script-output', itemId: 'dev' })
    expect(focused.surfaces.scriptOutput).toEqual({
      name: 'dev',
      status: 'running',
      tail: ['line one', 'line two']
    })
    expect(focused.runningScript).toEqual({ name: 'dev', status: 'running' })

    const unfocused = composeScreenContext(baseState({ runningScript }), {})
    expect(unfocused.focus.surface).toBe('navigator')
    expect(unfocused.surfaces.scriptOutput).toBeUndefined()
    expect(unfocused.runningScript).toEqual({ name: 'dev', status: 'running' })
  })

  it('runningScript is null when nothing is running', () => {
    const out = composeScreenContext(baseState(), {})
    expect(out.runningScript).toBeNull()
  })
})
