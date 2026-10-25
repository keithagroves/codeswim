// The build hand-off and its checkpoint (plans/talking-whiteboard.md, "Build
// hand-off and checkpoint").
//
// The agreed design brief goes to the workspace's normal agent session (the
// one the Agent panel shows), so the existing harness takes it from there:
// `diagram_edit` first — the plugin blocks code edits until then — then code.
// While it runs, this collects what a walkthrough needs from the event
// stream: each diagram_edit (file and contents), the files the edit tools
// touched, and `session.idle` for when it's done. Then it asks opencode for
// that turn's diff.

import { createTwoFilesPatch } from 'diff'
import { builderPrompt, type ChangedFile, type DiagramEdit } from '@codeswim/whiteboard'
import type { AgentClient, FileDiff } from '../agent'
import type { BuildOutcome } from './controller'

export interface SendOutcome {
  status: 'ok' | 'error' | 'stopped'
  error?: string
  /** The agent's final message text. */
  finalText: string
}

export interface BuildDeps {
  agent: Pick<
    AgentClient,
    'subscribeParts' | 'subscribeSessionEvents' | 'loadMessages' | 'sessionDiff'
  >
  sessionId: string
  root: string
  /** Send the prompt through the chat (so it shows in the Agent panel) and wait for the turn. */
  send(prompt: string): Promise<SendOutcome>
  /** Fallback diff for one file, when opencode has no per-turn diff. */
  gitFileDiff(path: string): Promise<string>
  /** Test seam. */
  sleep?(ms: number): Promise<void>
}

const EDIT_TOOLS = new Set(['write', 'edit', 'multiedit'])

/** A workspace-relative POSIX path, whatever form opencode reported it in. */
export function relativePath(root: string, p: string): string {
  const posix = p.replace(/\\/g, '/')
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '')
  return posix.startsWith(`${base}/`) ? posix.slice(base.length + 1) : posix.replace(/^\.\//, '')
}

export async function runWhiteboardBuild(
  deps: BuildDeps,
  brief: string,
  pagesInWords: string,
  conversation = ''
): Promise<BuildOutcome> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const { agent, sessionId, root } = deps
  const diagrams = new Map<string, string>()
  const edited = new Set<string>()

  let resolveIdle!: () => void
  const idle = new Promise<void>((r) => (resolveIdle = r))
  const unsubParts = agent.subscribeParts(({ sessionID, part }) => {
    if (
      sessionID !== sessionId ||
      part.kind !== 'tool' ||
      part.status !== 'completed' ||
      !part.input
    )
      return
    const input = part.input
    // A tool can complete yet report a failure in its output (diagram_edit's
    // validation errors, the diagrams-first gate); that's no edit at all.
    if (/^\s*error\b/i.test(part.output ?? '')) return
    if (
      part.tool === 'diagram_edit' &&
      typeof input.file === 'string' &&
      typeof input.content === 'string'
    ) {
      diagrams.set(relativePath(root, input.file), input.content)
    } else if (part.tool && EDIT_TOOLS.has(part.tool)) {
      const p = input.filePath ?? input.path
      if (typeof p === 'string') edited.add(relativePath(root, p))
    }
  })
  const unsubEvents = agent.subscribeSessionEvents((e) => {
    if (e.type === 'idle' && e.sessionID === sessionId) resolveIdle()
    if (e.type === 'file-edited') edited.add(relativePath(root, e.file))
  })

  try {
    const sent = await deps.send(builderPrompt(brief, pagesInWords, conversation))
    // send() settles when the turn ends; idle normally lands right around it.
    await Promise.race([idle, sleep(3000)])

    const diffs = await turnDiff(agent, sessionId, sleep)
    for (const d of diffs) {
      const rel = relativePath(root, d.file)
      const after = afterText(d)
      if (rel.endsWith('.md') && !diagrams.has(rel) && after && /```+\s*mermaid/.test(after)) {
        diagrams.set(rel, after)
      }
    }
    let files: ChangedFile[]
    let diff: string
    if (diffs.length) {
      files = diffs.map((d) => ({
        file: relativePath(root, d.file),
        additions: d.additions,
        deletions: d.deletions
      }))
      diff = diffs.map((d) => patchOf(root, d)).join('\n')
    } else {
      const paths = [...new Set([...diagrams.keys(), ...edited])]
      files = paths.map((file) => ({ file, additions: 0, deletions: 0 }))
      const parts = await Promise.all(paths.map((p) => deps.gitFileDiff(p).catch(() => '')))
      diff = parts.filter(Boolean).join('\n')
    }

    const diagramEdits: DiagramEdit[] = [...diagrams].map(([path, after]) => ({ path, after }))
    return {
      checkpoint: {
        brief,
        diagrams: diagramEdits,
        files,
        finalMessage: sent.finalText,
        ...(sent.status === 'stopped' ? { stopped: true } : {}),
        ...(sent.status === 'error' ? { error: sent.error ?? 'The agent failed.' } : {})
      },
      diff
    }
  } finally {
    unsubParts()
    unsubEvents()
  }
}

/**
 * What the build turn changed: opencode's diff for the turn's user message
 * (the brief). Its per-turn summary can land a moment after idle, so an empty
 * answer is retried once.
 */
async function turnDiff(
  agent: BuildDeps['agent'],
  sessionId: string,
  sleep: (ms: number) => Promise<void>
): Promise<FileDiff[]> {
  try {
    const messages = await agent.loadMessages(sessionId)
    const brief = [...messages].reverse().find((m) => m.role === 'user')
    if (!brief) return []
    for (let attempt = 0; attempt < 2; attempt++) {
      const diffs = await agent.sessionDiff(sessionId, brief.id)
      if (diffs.length) return diffs
      if (attempt === 0) await sleep(1500)
    }
  } catch {
    // Best-effort: the caller falls back to the files it saw being edited.
  }
  return []
}

/** A file diff as a unified patch, from whichever shape opencode sent. */
export function patchOf(root: string, d: FileDiff): string {
  if (d.patch) return d.patch.endsWith('\n') ? d.patch : `${d.patch}\n`
  const rel = relativePath(root, d.file)
  return createTwoFilesPatch(`a/${rel}`, `b/${rel}`, d.before ?? '', d.after ?? '', '', '', {
    context: 3
  })
}

/**
 * The file's contents after the change, when the diff carries them: `after`
 * in the older shape, or the added lines of a new file's patch.
 */
export function afterText(d: FileDiff): string | null {
  if (typeof d.after === 'string') return d.after
  if (d.status !== 'added' || !d.patch) return null
  return d.patch
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1))
    .join('\n')
}
