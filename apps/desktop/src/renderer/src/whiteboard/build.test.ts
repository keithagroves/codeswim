import { describe, expect, it } from 'vitest'
import type { AssistantPart, FileDiff, LoadedMessage, PartUpdate, SessionEvent } from '../agent'
import { relativePath, runWhiteboardBuild, type BuildDeps, type SendOutcome } from './build'

interface FakeAgent {
  agent: BuildDeps['agent']
  send(prompt: string): Promise<SendOutcome>
  sent: string[]
  partHandlers: Set<(u: PartUpdate) => void>
  eventHandlers: Set<(e: SessionEvent) => void>
}

/** A fake agent whose send() replays a build's event stream. */
function fakeAgent(opts: {
  diffs?: FileDiff[][]
  events: (emit: Emitters) => void
  outcome?: SendOutcome
}): FakeAgent {
  const partHandlers = new Set<(u: PartUpdate) => void>()
  const eventHandlers = new Set<(e: SessionEvent) => void>()
  const diffs = [...(opts.diffs ?? [])]
  const sent: string[] = []
  const emit: Emitters = {
    part: (part) => partHandlers.forEach((h) => h({ sessionID: 's1', messageID: 'm2', part })),
    otherSessionPart: (part) =>
      partHandlers.forEach((h) => h({ sessionID: 'other', messageID: 'x', part })),
    event: (e) => eventHandlers.forEach((h) => h(e))
  }
  const agent: BuildDeps['agent'] = {
    subscribeParts: (h) => {
      partHandlers.add(h)
      return () => partHandlers.delete(h)
    },
    subscribeSessionEvents: (h) => {
      eventHandlers.add(h)
      return () => eventHandlers.delete(h)
    },
    loadMessages: async (): Promise<LoadedMessage[]> => [
      { id: 'm0', role: 'user', parts: [] },
      { id: 'm1', role: 'assistant', parts: [] },
      { id: 'm-brief', role: 'user', parts: [] },
      { id: 'm2', role: 'assistant', parts: [] }
    ],
    sessionDiff: async (_s, messageID) => {
      expect(messageID).toBe('m-brief')
      return diffs.shift() ?? []
    }
  }
  const send = async (prompt: string): Promise<SendOutcome> => {
    sent.push(prompt)
    opts.events(emit)
    return opts.outcome ?? { status: 'ok', finalText: 'Built the auth service.' }
  }
  return { agent, send, sent, partHandlers, eventHandlers }
}

interface Emitters {
  part(p: AssistantPart): void
  otherSessionPart(p: AssistantPart): void
  event(e: SessionEvent): void
}

const tool = (
  tool: string,
  input: Record<string, unknown>,
  status: AssistantPart['status'] = 'completed'
): AssistantPart => ({
  id: `${tool}-${Math.random()}`,
  kind: 'tool',
  tool,
  status,
  input
})

describe('runWhiteboardBuild', () => {
  it('sends the brief diagram-first and collects the checkpoint', async () => {
    const diagram = '---\nname: Auth\n---\n```mermaid\nflowchart LR\n  A --> B\n```\n'
    const f = fakeAgent({
      diffs: [
        [],
        [
          { file: 'architecture/auth.md', before: '', after: diagram, additions: 6, deletions: 0 },
          { file: '/ws/src/auth.ts', before: 'a\n', after: 'a\nb\n', additions: 1, deletions: 0 }
        ]
      ],
      events: (emit) => {
        emit.part(
          tool('diagram_edit', { file: 'architecture/auth.md', content: diagram }, 'running')
        )
        emit.part(tool('diagram_edit', { file: 'architecture/auth.md', content: diagram }))
        emit.otherSessionPart(tool('diagram_edit', { file: 'architecture/other.md', content: 'x' }))
        emit.part({
          ...tool('diagram_edit', { file: 'architecture/bad.md', content: 'no tags' }),
          output: 'error: frontmatter must include `tags` as a list'
        })
        emit.part(tool('edit', { filePath: '/ws/src/auth.ts' }))
        emit.event({ type: 'idle', sessionID: 's1' })
      }
    })
    const outcome = await runWhiteboardBuild(
      {
        agent: f.agent,
        sessionId: 's1',
        root: '/ws',
        send: f.send,
        gitFileDiff: async () => '',
        sleep: async () => {}
      },
      'Add an auth service.',
      'Page "Auth":\n- Auth'
    )
    expect(f.sent[0]).toContain('<design-brief>\nAdd an auth service.\n</design-brief>')
    expect(f.sent[0]).toContain('diagram_edit before any code edit')
    expect(outcome.checkpoint.diagrams).toEqual([{ path: 'architecture/auth.md', after: diagram }])
    expect(outcome.checkpoint.files).toEqual([
      { file: 'architecture/auth.md', additions: 6, deletions: 0 },
      { file: 'src/auth.ts', additions: 1, deletions: 0 }
    ])
    expect(outcome.checkpoint.finalMessage).toBe('Built the auth service.')
    expect(outcome.diff).toContain('+++ b/src/auth.ts')
    expect(outcome.diff).toContain('+b')
    // Subscriptions are released.
    expect(f.partHandlers.size).toBe(0)
    expect(f.eventHandlers.size).toBe(0)
  })

  it('falls back to the files it saw edited when opencode has no turn diff', async () => {
    const f = fakeAgent({
      diffs: [[], []],
      events: (emit) => {
        emit.part(tool('write', { filePath: '/ws/src/cache.ts' }))
        emit.event({ type: 'file-edited', file: '/ws/src/cache.test.ts' })
        emit.event({ type: 'idle', sessionID: 's1' })
      }
    })
    const outcome = await runWhiteboardBuild(
      {
        agent: f.agent,
        sessionId: 's1',
        root: '/ws',
        send: f.send,
        gitFileDiff: async (p) => `diff --git a/${p} b/${p}`,
        sleep: async () => {}
      },
      'Add caching.',
      ''
    )
    expect(outcome.checkpoint.files.map((x) => x.file).sort()).toEqual([
      'src/cache.test.ts',
      'src/cache.ts'
    ])
    expect(outcome.diff).toContain('diff --git a/src/cache.ts')
  })

  it('records a stopped or failed build', async () => {
    const stopped = fakeAgent({ events: () => {}, outcome: { status: 'stopped', finalText: '' } })
    const a = await runWhiteboardBuild(
      {
        agent: stopped.agent,
        sessionId: 's1',
        root: '/ws',
        send: stopped.send,
        gitFileDiff: async () => '',
        sleep: async () => {}
      },
      'x',
      ''
    )
    expect(a.checkpoint.stopped).toBe(true)
    const failed = fakeAgent({
      events: () => {},
      outcome: { status: 'error', error: 'rate limited', finalText: '' }
    })
    const b = await runWhiteboardBuild(
      {
        agent: failed.agent,
        sessionId: 's1',
        root: '/ws',
        send: failed.send,
        gitFileDiff: async () => '',
        sleep: async () => {}
      },
      'x',
      ''
    )
    expect(b.checkpoint.error).toBe('rate limited')
  })
})

describe('relativePath', () => {
  it('normalizes absolute and ./ paths', () => {
    expect(relativePath('/ws', '/ws/src/a.ts')).toBe('src/a.ts')
    expect(relativePath('/ws/', '/ws/src/a.ts')).toBe('src/a.ts')
    expect(relativePath('/ws', './src/a.ts')).toBe('src/a.ts')
    expect(relativePath('/ws', 'src/a.ts')).toBe('src/a.ts')
    expect(relativePath('C:\\ws', 'C:\\ws\\src\\a.ts')).toBe('src/a.ts')
  })
})

describe('opencode 1.18 diff shape', () => {
  it('uses the patch and recovers a new diagram from it', async () => {
    const patch =
      'Index: architecture/s.md\n===\n--- architecture/s.md\t\n+++ architecture/s.md\t\n@@ -0,0 +1,3 @@\n+```mermaid\n+flowchart LR\n+```\n'
    const f = fakeAgent({
      diffs: [[{ file: 'architecture/s.md', patch, status: 'added', additions: 3, deletions: 0 }]],
      events: (emit) => emit.event({ type: 'idle', sessionID: 's1' })
    })
    const outcome = await runWhiteboardBuild(
      {
        agent: f.agent,
        sessionId: 's1',
        root: '/ws',
        send: f.send,
        gitFileDiff: async () => '',
        sleep: async () => {}
      },
      'x',
      ''
    )
    expect(outcome.diff).toBe(patch)
    expect(outcome.checkpoint.diagrams).toEqual([
      { path: 'architecture/s.md', after: '```mermaid\nflowchart LR\n```' }
    ])
  })
})
