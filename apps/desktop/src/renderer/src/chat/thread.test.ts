import { describe, expect, it } from 'vitest'
import { builderPrompt } from '@codeswim/whiteboard'
import type { ChatMessage } from '../store'
import type { TranscriptEntry } from '../whiteboard/controller'
import { buildBriefOf, mergeThread } from './thread'

const msg = (id: string, createdAt?: number): ChatMessage => ({
  id,
  role: 'assistant',
  parts: [{ kind: 'text', text: id }],
  ...(createdAt !== undefined ? { createdAt } : {})
})
const said = (id: number, at?: number, session?: string | null): TranscriptEntry => ({
  id,
  who: 'narrator',
  text: `said ${id}`,
  ...(at !== undefined ? { at } : {}),
  ...(session !== undefined ? { session } : {})
})
const ids = (items: ReturnType<typeof mergeThread>): string[] =>
  items.map((i) => (i.kind === 'message' ? i.message.id : `wb${i.entry.id}`))

describe('mergeThread', () => {
  it('interleaves the narrator with the agent by time', () => {
    const items = mergeThread(
      [msg('m1', 100), msg('m2', 300)],
      [said(1, 50, 's1'), said(2, 200, 's1'), said(3, 400, 's1')],
      's1'
    )
    expect(ids(items)).toEqual(['wb1', 'm1', 'wb2', 'm2', 'wb3'])
  })

  it("keeps another session's narrator out, but shows untagged and untimed entries", () => {
    const items = mergeThread(
      [msg('m1', 100)],
      [said(1), said(2, 50, 'other'), said(3, 150, null), said(4, 160, 's1')],
      's1'
    )
    expect(ids(items)).toEqual(['wb1', 'm1', 'wb3', 'wb4'])
  })

  it('places messages without a time where they are', () => {
    expect(ids(mergeThread([msg('live')], [said(1, 10, 's1')], 's1'))).toEqual(['live', 'wb1'])
  })
})

describe('buildBriefOf', () => {
  it('finds the brief in a whiteboard hand-off and nothing in other messages', () => {
    const prompt = builderPrompt(
      'Widen the buttons to 260 pixels.',
      'Page: Landing',
      'Person: wider'
    )
    expect(buildBriefOf(prompt)).toBe('Widen the buttons to 260 pixels.')
    expect(buildBriefOf('Build this design please')).toBeNull()
    expect(buildBriefOf('How does auth work?')).toBeNull()
  })
})
