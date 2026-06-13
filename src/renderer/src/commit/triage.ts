// Sync triage: turn the whole working diff into a plain-language plan a
// non-coder can act on. The agent decides how to GROUP the changes into one or
// more commits, flags files that probably shouldn't be committed (secrets,
// build output, large blobs), and judges whether the situation is simple enough
// to commit without asking. This is the "press Sync and an agent sorts it out"
// flow — staging is never shown to the user.
//
// Like commit/synthesize.ts, the prompt is assembled in the renderer (it varies
// per change set) while the agent's system prompt stays in the harness. Each
// commit group's `body` is still the regenerating prompt, same contract as the
// single-commit path.

export interface IgnoreSuggestion {
  // A .gitignore pattern, e.g. '.env' or 'dist/'.
  pattern: string
  // Plain-language reason a newcomer can understand.
  reason: string
}

export interface CommitGroup {
  // Friendly subject line: imperative, <= 72 chars, no trailing period.
  subject: string
  // Body: the prompt that would regenerate this change.
  body: string
  // Repo-relative paths this commit should include. Must be a subset of the
  // paths offered in the prompt — we filter to known paths after parsing.
  paths: string[]
}

export interface SyncPlan {
  // One-sentence, plain-language summary of everything that changed.
  summary: string
  // True when the change is simple and safe enough to commit with no review —
  // a single coherent group and nothing flagged to ignore.
  obvious: boolean
  groups: CommitGroup[]
  ignore: IgnoreSuggestion[]
}

const MAX_DIFF_CHARS = 60_000

export function buildTriagePrompt(
  diff: string,
  changedPaths: string[],
  instruction?: string
): string {
  let body = diff
  let truncatedNote = ''
  if (diff.length > MAX_DIFF_CHARS) {
    body = diff.slice(0, MAX_DIFF_CHARS)
    truncatedNote =
      '\n\n[diff truncated for length — group from what is shown; if unsure, keep everything in one group and set obvious to false]'
  }

  const note = instruction?.trim()
  const userNote = note
    ? [
        '',
        "The user reviewed your previous plan and asked for this change — honor it, and set obvious to false since they're reviewing:",
        `"""${note}"""`
      ]
    : []

  return [
    'You are helping a NON-PROGRAMMER commit their work. They pressed "Sync". Your job is to look at everything that changed and produce a simple plan: how to split it into one or more commits, whether any files should NOT be committed, and whether it is safe to just commit without asking.',
    '',
    'Decide the following:',
    '1. GROUPS — split the changes into commits by intent. Closely related edits belong together; unrelated changes (e.g. a diagram tweak and a separate bugfix) belong in separate commits. Most of the time there is just ONE group. Each group needs:',
    '   - subject: imperative, <= 72 chars, no trailing period, plain English a non-coder would recognize.',
    '   - body: a short prompt describing WHAT changed and WHY, precise enough to regenerate equivalent work. No line-by-line restatement.',
    '   - paths: the exact repo-relative paths (from the list below) in this group. Every changed path must appear in exactly one group, unless you put it under ignore instead.',
    '2. IGNORE — flag any path that almost certainly should NOT be committed: secrets (.env, key files, tokens), build output (dist/, node_modules/), logs, OS cruft, or large binaries. Give a gitignore pattern and a one-line plain reason. Leave empty if nothing qualifies.',
    '3. OBVIOUS — set true ONLY when it is safe to commit immediately with no human review: exactly one group AND nothing in ignore AND no secrets anywhere in the diff. Otherwise false.',
    '4. SUMMARY — one friendly sentence describing what changed overall.',
    '',
    'Rules:',
    '- NEVER echo secrets (API keys, tokens, passwords, connection strings) in any subject, body, or summary — describe their role generically.',
    '- Use ONLY paths from the list provided; do not invent paths.',
    '- Output ONLY a JSON object between <plan> and </plan> markers, no prose outside them.',
    '',
    'JSON shape:',
    '<plan>',
    '{',
    '  "summary": "string",',
    '  "obvious": true,',
    '  "groups": [{ "subject": "string", "body": "string", "paths": ["path/one"] }],',
    '  "ignore": [{ "pattern": ".env", "reason": "string" }]',
    '}',
    '</plan>',
    '',
    'Changed paths:',
    changedPaths.map((p) => `- ${p}`).join('\n') || '- (none reported)',
    ...userNote,
    '',
    'Working diff:',
    '```diff',
    body,
    '```' + truncatedNote
  ].join('\n')
}

interface RawPlan {
  summary?: unknown
  obvious?: unknown
  groups?: unknown
  ignore?: unknown
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter((x) => x.length > 0)
}

// Parse the agent's reply into a SyncPlan. Tolerant of the model wrapping the
// JSON in <plan> markers, a ```json fence, or neither. `validPaths` is the set
// of paths we actually offered; we drop any path the model invented and any
// group left with no real paths, so the plan can only act on real changes.
export function parseSyncPlan(raw: string, validPaths: string[]): SyncPlan {
  const valid = new Set(validPaths)
  const json = extractJson(raw)
  let parsed: RawPlan
  try {
    parsed = JSON.parse(json) as RawPlan
  } catch {
    throw new Error('The agent did not return a readable plan.')
  }

  const groups: CommitGroup[] = Array.isArray(parsed.groups)
    ? parsed.groups
        .map((g): CommitGroup => {
          const obj = (g ?? {}) as Record<string, unknown>
          return {
            subject: asString(obj.subject).replace(/\.$/, ''),
            body: asString(obj.body),
            paths: asStringArray(obj.paths).filter((p) => valid.has(p))
          }
        })
        .filter((g) => g.subject.length > 0 && g.paths.length > 0)
    : []

  const ignore: IgnoreSuggestion[] = Array.isArray(parsed.ignore)
    ? parsed.ignore
        .map((i): IgnoreSuggestion => {
          const obj = (i ?? {}) as Record<string, unknown>
          return { pattern: asString(obj.pattern), reason: asString(obj.reason) }
        })
        .filter((i) => i.pattern.length > 0)
    : []

  // The model's own obvious flag, but never trust it past our own guardrails:
  // only one group and nothing flagged to ignore can count as auto-committable.
  const obvious = parsed.obvious === true && groups.length === 1 && ignore.length === 0

  return {
    summary: asString(parsed.summary),
    obvious,
    groups,
    ignore
  }
}

function extractJson(raw: string): string {
  const text = raw.trim()
  const marked = text.match(/<plan>\s*([\s\S]*?)\s*<\/plan>/i)
  if (marked) return marked[1].trim()
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fenced) return fenced[1].trim()
  // Last resort: from the first brace to the last.
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first !== -1 && last > first) return text.slice(first, last + 1)
  return text
}
