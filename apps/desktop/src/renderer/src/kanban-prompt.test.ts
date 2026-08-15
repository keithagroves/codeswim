import { describe, expect, it } from 'vitest'
import { buildCardPrompt } from './kanban-prompt'
import type { KanbanCard } from '@codeswim/contract'

function card(overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: 'c1',
    title: 'Add rate limiting',
    description: '',
    columnId: 'backlog',
    priority: 'medium',
    labels: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

describe('buildCardPrompt', () => {
  it('includes the title and priority for a bare card', () => {
    const prompt = buildCardPrompt(card())
    expect(prompt).toContain('Work on this task from the board: "Add rate limiting"')
    expect(prompt).toContain('Priority: Medium')
    expect(prompt).toContain('Start working on this now.')
  })

  it('includes the description when present', () => {
    const prompt = buildCardPrompt(card({ description: 'Use a token bucket per API key.' }))
    expect(prompt).toContain('Use a token bucket per API key.')
  })

  it('omits the description block when empty or whitespace-only', () => {
    const prompt = buildCardPrompt(card({ description: '   ' }))
    expect(prompt).not.toMatch(/\n\s*\n\s*\n/) // no stray blank block
  })

  it('includes labels when present', () => {
    const prompt = buildCardPrompt(card({ labels: ['backend', 'security'] }))
    expect(prompt).toContain('Labels: backend, security')
  })

  it('omits the labels line when there are none', () => {
    const prompt = buildCardPrompt(card())
    expect(prompt).not.toContain('Labels:')
  })

  it('includes the linked path when present', () => {
    const prompt = buildCardPrompt(card({ linkedPath: 'architecture/api.md' }))
    expect(prompt).toContain('Related file/diagram: architecture/api.md')
  })

  it('omits the linked path line when absent', () => {
    const prompt = buildCardPrompt(card())
    expect(prompt).not.toContain('Related file/diagram:')
  })

  it('maps all three priority levels to a capitalized label', () => {
    expect(buildCardPrompt(card({ priority: 'low' }))).toContain('Priority: Low')
    expect(buildCardPrompt(card({ priority: 'high' }))).toContain('Priority: High')
  })
})
