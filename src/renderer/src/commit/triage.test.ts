import { describe, it, expect } from 'vitest'
import { parseSyncPlan, buildTriagePrompt } from './triage'

const valid = ['src/a.ts', 'src/b.ts', '.env']

function plan(obj: unknown): string {
  return `<plan>${JSON.stringify(obj)}</plan>`
}

describe('parseSyncPlan', () => {
  it('parses a single-group plan and marks it obvious', () => {
    const raw = plan({
      summary: 'Tidy up the helpers.',
      obvious: true,
      groups: [{ subject: 'Refactor helpers', body: 'Pull shared logic out.', paths: ['src/a.ts'] }],
      ignore: []
    })
    const result = parseSyncPlan(raw, valid)
    expect(result.summary).toBe('Tidy up the helpers.')
    expect(result.obvious).toBe(true)
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].subject).toBe('Refactor helpers')
  })

  it('drops invented paths and discards groups left empty', () => {
    const raw = plan({
      summary: 's',
      obvious: true,
      groups: [
        { subject: 'Real', body: '', paths: ['src/a.ts', 'src/made-up.ts'] },
        { subject: 'Ghost', body: '', paths: ['does/not/exist.ts'] }
      ],
      ignore: []
    })
    const result = parseSyncPlan(raw, valid)
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].paths).toEqual(['src/a.ts'])
  })

  it('never reports obvious with multiple groups', () => {
    const raw = plan({
      summary: 's',
      obvious: true,
      groups: [
        { subject: 'One', body: '', paths: ['src/a.ts'] },
        { subject: 'Two', body: '', paths: ['src/b.ts'] }
      ],
      ignore: []
    })
    expect(parseSyncPlan(raw, valid).obvious).toBe(false)
  })

  it('never reports obvious when something is flagged to ignore', () => {
    const raw = plan({
      summary: 's',
      obvious: true,
      groups: [{ subject: 'One', body: '', paths: ['src/a.ts'] }],
      ignore: [{ pattern: '.env', reason: 'secrets' }]
    })
    const result = parseSyncPlan(raw, valid)
    expect(result.obvious).toBe(false)
    expect(result.ignore).toEqual([{ pattern: '.env', reason: 'secrets' }])
  })

  it('strips a trailing period from group subjects', () => {
    const raw = plan({
      summary: 's',
      obvious: true,
      groups: [{ subject: 'Add a thing.', body: '', paths: ['src/a.ts'] }],
      ignore: []
    })
    expect(parseSyncPlan(raw, valid).groups[0].subject).toBe('Add a thing')
  })

  it('reads JSON from a ```json fence when markers are absent', () => {
    const raw = '```json\n' + JSON.stringify({ summary: 'x', obvious: false, groups: [], ignore: [] }) + '\n```'
    expect(parseSyncPlan(raw, valid).summary).toBe('x')
  })

  it('throws on unreadable output', () => {
    expect(() => parseSyncPlan('not a plan at all', valid)).toThrow()
  })
})

describe('buildTriagePrompt', () => {
  it('lists the changed paths and embeds the diff', () => {
    const prompt = buildTriagePrompt('diff --git a b', ['src/a.ts', 'src/b.ts'])
    expect(prompt).toContain('- src/a.ts')
    expect(prompt).toContain('- src/b.ts')
    expect(prompt).toContain('diff --git a b')
  })

  it('includes the user adjustment and tells the model to drop obvious', () => {
    const prompt = buildTriagePrompt('d', ['src/a.ts'], 'keep it all in one commit')
    expect(prompt).toContain('keep it all in one commit')
    expect(prompt).toContain('set obvious to false')
  })
})
