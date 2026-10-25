import { describe, expect, it } from 'vitest'
import { toAssistantPart, toSessionEvent, type RawPart } from './agent'

const raw = (over: Partial<RawPart>): RawPart => ({
  id: 'p1',
  sessionID: 's1',
  messageID: 'm1',
  type: 'tool',
  ...over
})

describe('toAssistantPart', () => {
  it('keeps input and title for the tools a build checkpoint reads', () => {
    const part = toAssistantPart(
      raw({
        tool: 'diagram_edit',
        state: {
          status: 'completed',
          input: { file: 'a.md', content: 'x' },
          title: 'a.md',
          output: 'wrote a.md'
        }
      })
    )
    expect(part).toMatchObject({
      kind: 'tool',
      tool: 'diagram_edit',
      input: { file: 'a.md', content: 'x' },
      title: 'a.md',
      output: 'wrote a.md'
    })
  })

  it('drops other tools’ inputs', () => {
    const part = toAssistantPart(
      raw({ tool: 'bash', state: { status: 'running', input: { command: 'ls' } } })
    )
    expect(part).not.toHaveProperty('input')
  })

  it('still skips synthetic parts and step markers', () => {
    expect(toAssistantPart(raw({ type: 'text', text: 'x', synthetic: true }))).toBeNull()
    expect(toAssistantPart(raw({ type: 'step-start' }))).toBeNull()
  })
})

describe('toSessionEvent', () => {
  it('forwards idle, diff, file edits and errors', () => {
    expect(toSessionEvent({ type: 'session.idle', properties: { sessionID: 's1' } })).toEqual({
      type: 'idle',
      sessionID: 's1'
    })
    expect(
      toSessionEvent({
        type: 'session.diff',
        properties: {
          sessionID: 's1',
          diff: [{ file: 'a', before: '', after: 'b', additions: 1, deletions: 0 }]
        }
      })
    ).toMatchObject({ type: 'diff', sessionID: 's1', diff: [{ file: 'a' }] })
    expect(toSessionEvent({ type: 'file.edited', properties: { file: '/ws/a.ts' } })).toEqual({
      type: 'file-edited',
      file: '/ws/a.ts'
    })
    expect(
      toSessionEvent({
        type: 'session.error',
        properties: {
          sessionID: 's1',
          error: { name: 'ApiError', data: { message: 'rate limited' } }
        }
      })
    ).toEqual({ type: 'error', sessionID: 's1', message: 'rate limited' })
    expect(toSessionEvent({ type: 'session.idle', properties: {} })).toBeNull()
    expect(toSessionEvent({ type: 'something.else' })).toBeNull()
  })
})
