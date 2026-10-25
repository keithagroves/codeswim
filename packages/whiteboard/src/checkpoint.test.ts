import { describe, expect, it } from 'vitest'
import { builderPrompt, formatCheckpoint, mermaidOf, projectSummary } from './checkpoint'

describe('builderPrompt', () => {
  it('hands the brief and the board to the builder, diagram-first', () => {
    const text = builderPrompt(
      'Add accounts with Firebase auth.',
      'Page "Accounts":\n- Firebase (chosen)'
    )
    expect(text).toContain('<design-brief>\nAdd accounts with Firebase auth.\n</design-brief>')
    expect(text).toContain('<whiteboard>\nPage "Accounts":\n- Firebase (chosen)\n</whiteboard>')
    expect(text).toContain('diagram_edit before any code edit')
  })

  it('leaves out an empty board', () => {
    expect(builderPrompt('x', '  ')).not.toContain('<whiteboard>')
  })
})

describe('mermaidOf', () => {
  it('extracts the mermaid block, any fence', () => {
    expect(mermaidOf('---\nname: a\n---\n\n````mermaid\nflowchart LR\n  A --> B\n````\n')).toBe(
      'flowchart LR\n  A --> B'
    )
    expect(mermaidOf('~~~mermaid\r\ngraph TD\r\n~~~\r\n')).toBe('graph TD')
    expect(mermaidOf('no diagram')).toBe('no diagram')
  })
})

describe('formatCheckpoint', () => {
  it('lists the brief, diagrams, files and final message', () => {
    const text = formatCheckpoint({
      brief: 'Add accounts.',
      diagrams: [
        { path: 'architecture/auth.md', after: '```mermaid\nflowchart LR\n  A --> B\n```' }
      ],
      files: [{ file: 'src/auth.ts', additions: 40, deletions: 2 }],
      finalMessage: 'Added the auth service.'
    })
    expect(text).toContain('Design brief:\nAdd accounts.')
    expect(text).toContain('architecture/auth.md\nflowchart LR\n  A --> B')
    expect(text).toContain('- src/auth.ts (+40 -2)')
    expect(text).toContain("The coding agent's final message:\nAdded the auth service.")
  })

  it('says when the build was stopped or produced nothing', () => {
    const text = formatCheckpoint({
      brief: 'x',
      diagrams: [],
      files: [],
      finalMessage: '',
      stopped: true
    })
    expect(text).toContain('stopped the build')
    expect(text).toContain('Diagrams edited: none.')
    expect(text).toContain('Files changed: none.')
  })
})

describe('projectSummary', () => {
  it('lists overview first, then architecture, then the rest', () => {
    const text = projectSummary([
      { path: 'flows/login.md', name: 'Login' },
      { path: 'architecture/auth.md', name: 'Auth', description: 'Sessions and tokens' },
      { path: 'overview.md', name: 'Triage' }
    ])
    const lines = text.split('\n').slice(1)
    expect(lines).toEqual([
      '- overview.md: Triage',
      '- architecture/auth.md: Auth (Sessions and tokens)',
      '- flows/login.md: Login'
    ])
    expect(projectSummary([])).toBe('')
  })
})

describe('builderPrompt with the conversation', () => {
  it('carries what was said on the whiteboard so the agent can answer about it later', () => {
    const text = builderPrompt(
      'Use Postgres.',
      '',
      'Person: should we use Postgres?\nNarrator: Postgres it is.'
    )
    expect(text).toContain('<whiteboard-conversation>\nPerson: should we use Postgres?')
    expect(builderPrompt('Use Postgres.', '')).not.toContain('<whiteboard-conversation>')
  })
})
