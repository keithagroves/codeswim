import { describe, expect, it } from 'vitest'
import { normalizePersistedAgentTabs, type PersistedAgentTabs } from './agent-tabs'

describe('normalizePersistedAgentTabs', () => {
  it('returns null for non-object input', () => {
    expect(normalizePersistedAgentTabs(null)).toBeNull()
    expect(normalizePersistedAgentTabs(undefined)).toBeNull()
    expect(normalizePersistedAgentTabs('nope')).toBeNull()
  })

  it('returns null when tabs is missing or not an array', () => {
    expect(normalizePersistedAgentTabs({})).toBeNull()
    expect(normalizePersistedAgentTabs({ tabs: 'nope' })).toBeNull()
  })

  it('returns null when every tab is malformed', () => {
    expect(normalizePersistedAgentTabs({ tabs: [{ id: 1 }] })).toBeNull()
  })

  it('round-trips a well-formed payload', () => {
    const data: PersistedAgentTabs = {
      tabs: [
        { id: 'tab-1', sessionId: 'ses_abc', title: 'Fix rate limiting', directory: null },
        { id: 'tab-2', sessionId: null, title: 'Agent 2', directory: null }
      ],
      activeAgentTabId: 'tab-2'
    }
    expect(normalizePersistedAgentTabs(JSON.parse(JSON.stringify(data)))).toEqual(data)
  })

  it('preserves a worktree directory override', () => {
    const result = normalizePersistedAgentTabs({
      tabs: [{ id: 'tab-1', sessionId: 'ses_abc', title: 'Card task', directory: '/tmp/wt/tab-1' }],
      activeAgentTabId: 'tab-1'
    })
    expect(result?.tabs[0].directory).toBe('/tmp/wt/tab-1')
  })

  it('drops individually malformed tabs but keeps the valid ones', () => {
    const result = normalizePersistedAgentTabs({
      tabs: [
        { id: 'tab-1', sessionId: 'ses_abc', title: 'Good tab' },
        { id: 'tab-2' }, // missing title
        { sessionId: 'ses_x', title: 'Missing id' },
        { id: 'tab-3', sessionId: 123, title: 'Bad sessionId type' }
      ],
      activeAgentTabId: 'tab-1'
    })
    expect(result?.tabs).toEqual([
      { id: 'tab-1', sessionId: 'ses_abc', title: 'Good tab', directory: null }
    ])
  })

  it('falls back to the first tab when activeAgentTabId is missing or points at a dropped tab', () => {
    const result = normalizePersistedAgentTabs({
      tabs: [
        { id: 'tab-1', sessionId: null, title: 'A' },
        { id: 'tab-2', sessionId: null, title: 'B' }
      ],
      activeAgentTabId: 'tab-missing'
    })
    expect(result?.activeAgentTabId).toBe('tab-1')
  })
})
