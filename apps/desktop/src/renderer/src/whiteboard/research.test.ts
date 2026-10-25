import { describe, expect, it, vi } from 'vitest'
import type { PartUpdate } from '../agent'
import {
  formatResearch,
  READ_ONLY_TOOLS,
  RESEARCH_SESSION_TITLE,
  runResearch,
  type ResearchDeps
} from './research'

type Agent = ResearchDeps['agent'] & {
  emit(u: PartUpdate): void
  finish(text: string): void
  fail(e: Error): void
}

function fakeAgent(): Agent {
  let handler: ((u: PartUpdate) => void) | null = null
  let settle: { resolve: (text: string) => void; reject: (e: Error) => void } | null = null
  const agent = {
    createSession: vi.fn(async () => ({
      id: 'ses_r',
      title: RESEARCH_SESSION_TITLE,
      createdAt: 0,
      updatedAt: 0
    })),
    deleteSession: vi.fn(async () => {}),
    stop: vi.fn(async () => {
      settle?.reject(new Error('aborted'))
    }),
    subscribeParts: vi.fn((h: (u: PartUpdate) => void) => {
      handler = h
      return () => (handler = null)
    }),
    send: vi.fn(
      () =>
        new Promise<{ messageID: string; parts: { kind: 'text'; text: string }[] }>(
          (resolve, reject) => {
            settle = {
              resolve: (text) => resolve({ messageID: 'm', parts: [{ kind: 'text', text }] }),
              reject
            }
          }
        )
    ),
    emit: (u: PartUpdate) => handler?.(u),
    finish: (text: string) => settle?.resolve(text),
    fail: (e: Error) => settle?.reject(e)
  }
  return agent as unknown as Agent
}

const read = (file: string, sessionID = 'ses_r'): PartUpdate => ({
  sessionID,
  messageID: 'm',
  part: {
    id: `p-${file}`,
    kind: 'tool',
    tool: 'read',
    status: 'completed',
    input: { filePath: `/ws/${file}` }
  }
})

describe('runResearch', () => {
  it('asks a read-only session, collects the files it read, and deletes the session', async () => {
    const agent = fakeAgent()
    const ctl = new AbortController()
    const run = runResearch(
      { agent, root: '/ws', signal: ctl.signal },
      'Where are permissions checked?'
    )
    await vi.waitFor(() => expect(agent.send).toHaveBeenCalled())
    const [sessionId, prompt, directory, , , tools] = vi.mocked(agent.send).mock.calls[0]
    expect(sessionId).toBe('ses_r')
    expect(directory).toBe('/ws')
    expect(prompt).toContain('Where are permissions checked?')
    expect(prompt).toContain('You can only read')
    expect(tools).toEqual(READ_ONLY_TOOLS)
    expect(agent.createSession).toHaveBeenCalledWith('/ws', RESEARCH_SESSION_TITLE)
    agent.emit(read('src/middleware.ts'))
    agent.emit(read('src/middleware.ts'))
    agent.emit(read('src/other.ts', 'someone-else'))
    agent.finish('checkAccess() in src/middleware.ts runs first.')
    expect(await run).toEqual({
      question: 'Where are permissions checked?',
      answer: 'checkAccess() in src/middleware.ts runs first.',
      files: ['src/middleware.ts']
    })
    await vi.waitFor(() => expect(agent.deleteSession).toHaveBeenCalledWith('ses_r', '/ws'))
  })

  it('stops the session when the person cancels', async () => {
    const agent = fakeAgent()
    const ctl = new AbortController()
    const run = runResearch({ agent, root: '/ws', signal: ctl.signal }, 'q')
    await vi.waitFor(() => expect(agent.send).toHaveBeenCalled())
    ctl.abort()
    expect(await run).toMatchObject({ stopped: true })
    expect(agent.stop).toHaveBeenCalledWith('ses_r', '/ws')
  })

  it('gives up after the time limit', async () => {
    const agent = fakeAgent()
    const run = runResearch(
      { agent, root: '/ws', signal: new AbortController().signal, timeoutMs: 20 },
      'q'
    )
    expect(await run).toMatchObject({ error: 'it took too long' })
  })
})

describe('formatResearch', () => {
  it('gives the narrator the answer and the files, or says what went wrong', () => {
    const text = formatResearch({
      question: 'Where?',
      answer: 'In middleware.',
      files: ['src/middleware.ts']
    })
    expect(text).toBe(
      "Question: Where?\n\nThe agent's answer:\nIn middleware.\n\nFiles it read:\n- src/middleware.ts"
    )
    expect(
      formatResearch({ question: 'Where?', answer: '', files: [], error: 'it took too long' })
    ).toContain("The agent couldn't finish: it took too long.\n\nThe agent found no answer.")
  })
})
