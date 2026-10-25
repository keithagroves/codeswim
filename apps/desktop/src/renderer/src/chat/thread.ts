// One conversation in the Agent panel: the agent's messages and the
// whiteboard narrator's, in the order they happened.
//
// The narrator's turns live in the whiteboard controller (they're spoken and
// drawn, not opencode messages), so the panel merges them in by time. Each
// narrator entry is tagged with the chat session it was said in and only
// shows in that session's thread; untagged ones (said before any session
// existed, or saved by an older build) show in whichever session is open.

import type { ChatMessage } from '../store'
import type { TranscriptEntry } from '../whiteboard/controller'

export type ThreadItem =
  { kind: 'message'; message: ChatMessage } | { kind: 'whiteboard'; entry: TranscriptEntry }

export function mergeThread(
  messages: readonly ChatMessage[],
  entries: readonly TranscriptEntry[],
  session: string | null
): ThreadItem[] {
  const mine = entries.filter((e) => !e.session || e.session === session)
  const out: ThreadItem[] = []
  let i = 0
  // Entries with no time (older saves) go first, as they were said before anything timed.
  while (i < mine.length && mine[i].at === undefined)
    out.push({ kind: 'whiteboard', entry: mine[i++] })
  for (const message of messages) {
    if (message.createdAt !== undefined) {
      while (i < mine.length && (mine[i].at ?? 0) < message.createdAt) {
        out.push({ kind: 'whiteboard', entry: mine[i++] })
      }
    }
    out.push({ kind: 'message', message })
  }
  while (i < mine.length) out.push({ kind: 'whiteboard', entry: mine[i++] })
  return out
}

/**
 * The design brief in a whiteboard build hand-off (checkpoint.ts
 * builderPrompt), or null for any other message. The panel shows a hand-off
 * as a short card instead of the whole prompt.
 */
export function buildBriefOf(text: string): string | null {
  if (!text.startsWith('Build this design.')) return null
  const m = /<design-brief>\n?([\s\S]*?)\n?<\/design-brief>/.exec(text)
  return m ? m[1].trim() : null
}
