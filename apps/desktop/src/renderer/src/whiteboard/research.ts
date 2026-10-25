// The narrator's way to find things out: a read-only look by the coding
// agent, in a hidden session on the workspace's opencode server.
//
// The narrator can't read code itself (it has no tools, which is what keeps
// it fast), so a {"research": "..."} line sends the question here. The
// session gets only opencode's reading and searching tools — the message's
// `tools` map turns everything else off, and opencode enforces that by not
// offering the rest — and is deleted afterwards. Its title starts with
// HIDDEN_SESSION_PREFIX, so it never shows in the session list.

import { HIDDEN_SESSION_PREFIX, type AgentClient, type SelectedModel } from '../agent'
import { relativePath } from './build'

/** Only reading and searching; opencode drops every other tool from the request. */
export const READ_ONLY_TOOLS: Record<string, boolean> = {
  '*': false,
  read: true,
  grep: true,
  glob: true,
  list: true
}

export const RESEARCH_SESSION_TITLE = `${HIDDEN_SESSION_PREFIX}research`
export const RESEARCH_TIMEOUT_MS = 120_000

const MAX_ANSWER = 3000
const MAX_FILES = 12

export interface ResearchOutcome {
  question: string
  /** The agent's answer, as it wrote it. */
  answer: string
  /** Workspace-relative files it read, in order. */
  files: string[]
  error?: string
  stopped?: boolean
}

export interface ResearchDeps {
  agent: Pick<AgentClient, 'createSession' | 'deleteSession' | 'send' | 'stop' | 'subscribeParts'>
  root: string
  model?: SelectedModel
  signal: AbortSignal
  timeoutMs?: number
}

/** What the read-only agent is asked to do. */
export function researchPrompt(question: string): string {
  return [
    'A colleague is talking through this codebase and asked a question. Find the answer by reading and searching the code. You can only read: do not try to change anything.',
    `<question>\n${question.trim()}\n</question>`,
    'Reply in under 200 words of plain prose: the answer first, then how you know. Name the files (workspace-relative paths, with line numbers where it helps) your answer rests on. If the code does not answer it, say so plainly instead of guessing.'
  ].join('\n\n')
}

export async function runResearch(deps: ResearchDeps, question: string): Promise<ResearchOutcome> {
  const { agent, root } = deps
  const session = await agent.createSession(root, RESEARCH_SESSION_TITLE)
  const files: string[] = []
  const unsub = agent.subscribeParts(({ sessionID, part }) => {
    if (sessionID !== session.id || part.kind !== 'tool' || part.tool !== 'read') return
    const p = part.input?.filePath ?? part.input?.path
    if (typeof p !== 'string') return
    const rel = relativePath(root, p)
    if (!files.includes(rel) && files.length < MAX_FILES) files.push(rel)
  })
  let timedOut = false
  const stop = (): void => void agent.stop(session.id, root).catch(() => {})
  const timer = setTimeout(() => {
    timedOut = true
    stop()
  }, deps.timeoutMs ?? RESEARCH_TIMEOUT_MS)
  deps.signal.addEventListener('abort', stop, { once: true })
  try {
    const reply = await agent.send(
      session.id,
      researchPrompt(question),
      root,
      deps.model,
      undefined,
      READ_ONLY_TOOLS
    )
    const answer = reply.parts
      .filter((p) => p.kind === 'text' && p.text)
      .map((p) => p.text as string)
      .join('')
      .trim()
      .slice(0, MAX_ANSWER)
    if (deps.signal.aborted) return { question, answer, files, stopped: true }
    if (timedOut) return { question, answer, files, error: 'it took too long' }
    return { question, answer, files }
  } catch (e) {
    if (deps.signal.aborted) return { question, answer: '', files, stopped: true }
    return {
      question,
      answer: '',
      files,
      error: timedOut ? 'it took too long' : e instanceof Error ? e.message : String(e)
    }
  } finally {
    clearTimeout(timer)
    deps.signal.removeEventListener('abort', stop)
    unsub()
    void agent.deleteSession(session.id, root).catch(() => {})
  }
}

/** The <research> block for the narrator's report. */
export function formatResearch(r: ResearchOutcome): string {
  const out = [`Question: ${r.question}`]
  if (r.error) out.push(`The agent couldn't finish: ${r.error}.`)
  out.push(r.answer ? `The agent's answer:\n${r.answer}` : 'The agent found no answer.')
  if (r.files.length) out.push(`Files it read:\n${r.files.map((f) => `- ${f}`).join('\n')}`)
  return out.join('\n\n')
}
