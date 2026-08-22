import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import type {
  GitStatus,
  GitCommitEntry,
  GitSyncResult,
  KanbanWorktreeInfo
} from '@codeswim/contract'
import { flattenChanges } from '../commands/git'
import type { CoverageReport } from '@codeswim/coverage'
import type { SyncPlan } from '@codeswim/commit'

type Tab = 'changes' | 'history'

// Compact relative time for the history list ("3h ago"); full ISO on hover.
function relTime(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const s = Math.floor((Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(mo / 12)}y ago`
}

// The Sync flow is a small state machine. We never show the user "staged" vs
// "unstaged" — they see their changes, press Sync, and the agent sorts out
// grouping / ignoring / committing.
type Phase =
  | { kind: 'idle' }
  | { kind: 'working'; label: string }
  | { kind: 'blocked'; report: CoverageReport }
  | { kind: 'plan'; plan: SyncPlan }
  | { kind: 'done'; commits: Array<{ subject: string; sha: string }>; sync: GitSyncResult }
  | { kind: 'error'; message: string }

// A card worktree's branch reads as `codeswim/<slug>-<base36 timestamp>`
// (see gitWorktreeAdd). Strip the prefix and that uniquing suffix back into
// something close to the card title for the target switcher. The suffix test
// requires a digit so a slug ending in a real word ("update-parser") keeps it.
function branchLabel(w: KanbanWorktreeInfo): string {
  if (!w.branch) return w.cardId
  const slug = w.branch
    .replace(/^codeswim\//, '')
    .replace(/-(?=[0-9a-z]{7,9}$)(?=[0-9a-z]*\d)[0-9a-z]+$/, '')
  return slug.replace(/-/g, ' ') || w.branch
}

export function GitPanel(): React.JSX.Element {
  const {
    state,
    toast,
    addToGitignore,
    syncDiagrams,
    showFileDiff,
    gitRefreshStatus,
    gitLoadHistory,
    gitInitRepo,
    gitSync,
    gitCommitPlan,
    kanbanListWorktrees
  } = useStore()
  const root = state.rootPath
  // Kanban "Run all" leaves each card's agent output uncommitted in its own
  // worktree, on purpose — nothing auto-commits. The Sync panel is where that
  // work becomes visible: pick a card branch as the target and the same
  // triage → commit → push flow runs there instead of the workspace.
  const [worktrees, setWorktrees] = useState<KanbanWorktreeInfo[]>([])
  const [targetCardId, setTargetCardId] = useState<string | null>(null)
  const target = worktrees.find((w) => w.cardId === targetCardId) ?? null
  // Everything below operates on `dir`: the workspace root, or a card worktree.
  const dir = target?.path ?? root
  const [git, setGit] = useState<GitStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [tab, setTab] = useState<Tab>('changes')
  const [commits, setCommits] = useState<GitCommitEntry[] | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  // Bumped after a successful commit so the History tab reloads next time.
  const [historyNonce, setHistoryNonce] = useState(0)
  // Row buttons, indexed alongside the changes list, so Up/Down can move focus.
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([])

  const refreshStatus = useCallback(async () => {
    if (!dir) return
    try {
      const s = await gitRefreshStatus(dir)
      setGit(s)
      setStatusError(null)
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err))
      setGit(null)
    }
  }, [dir, gitRefreshStatus])

  // Load on mount / when the workspace changes, and whenever the file tree
  // shifts. Inlined (rather than calling refreshStatus) so the only setState
  // calls happen after an await — keeps the effect off the cascading-render
  // path.
  useEffect(() => {
    if (!dir) return
    let cancelled = false
    void (async () => {
      try {
        const s = await gitRefreshStatus(dir)
        if (!cancelled) {
          setGit(s)
          setStatusError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setStatusError(err instanceof Error ? err.message : String(err))
          setGit(null)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [dir, state.tree, gitRefreshStatus])

  // Card worktrees. Refreshed alongside status, but note that a "Run all"
  // launch — or an agent editing files inside a worktree — changes nothing in
  // the watched workspace tree, so the ↻ button is the reliable way to pick up
  // new branches and change counts. If the selected worktree has gone away
  // (removed by hand, or the run was cleaned up), fall back to the workspace
  // rather than showing a dead target.
  const refreshWorktrees = useCallback(async () => {
    if (!root) return
    try {
      const list = await kanbanListWorktrees(root)
      setWorktrees(list)
      setTargetCardId((id) => (id && !list.some((w) => w.cardId === id) ? null : id))
    } catch {
      setWorktrees([])
    }
  }, [root, kanbanListWorktrees])

  useEffect(() => {
    if (!root) return
    let cancelled = false
    void (async () => {
      try {
        const list = await kanbanListWorktrees(root)
        if (cancelled) return
        setWorktrees(list)
        setTargetCardId((id) => (id && !list.some((w) => w.cardId === id) ? null : id))
      } catch {
        if (!cancelled) setWorktrees([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [root, state.tree, historyNonce, kanbanListWorktrees])

  // Load commit history when the History tab is active (and after each new
  // commit, via historyNonce).
  useEffect(() => {
    if (tab !== 'history' || !dir) return
    let cancelled = false
    void (async () => {
      try {
        const log = await gitLoadHistory(dir, 200)
        if (!cancelled) {
          setCommits(log)
          setHistoryError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setHistoryError(err instanceof Error ? err.message : String(err))
          setCommits([])
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [tab, dir, historyNonce, gitLoadHistory])

  // Commits every group in a plan, then backs the commits up to the remote
  // (pull + push) — see commands/git.ts's doCommitPlan for the actual work.
  // The commits are saved locally before the network is touched, so a
  // failed/absent push never loses the user's work.
  const commitPlan = useCallback(
    async (plan: SyncPlan) => {
      if (!dir) return
      setPhase({ kind: 'working', label: 'Saving…' })
      try {
        const { commits: done, sync } = await gitCommitPlan(dir, plan)
        setPhase({ kind: 'done', commits: done, sync })
        setHistoryNonce((n) => n + 1)
        await refreshStatus()
      } catch (err) {
        setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    },
    [dir, gitCommitPlan, refreshStatus]
  )

  // The Sync button — see commands/git.ts's doSync for the coverage
  // gate → triage → auto-commit-if-obvious flow.
  const onSync = useCallback(
    async (instruction?: string) => {
      if (!dir) return
      setPhase({ kind: 'working', label: 'Looking at your changes…' })
      try {
        const outcome = await gitSync(dir, target !== null, instruction)
        switch (outcome.kind) {
          case 'blocked':
            setPhase({ kind: 'blocked', report: outcome.report })
            return
          case 'nothing-changed':
            setPhase({ kind: 'error', message: 'Nothing has changed since your last commit.' })
            return
          case 'plan':
            setPhase({ kind: 'plan', plan: outcome.plan })
            return
          case 'done':
            setPhase({ kind: 'done', commits: outcome.commits, sync: outcome.sync })
            setHistoryNonce((n) => n + 1)
            await refreshStatus()
            return
        }
      } catch (err) {
        setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    },
    [dir, target, gitSync, refreshStatus]
  )

  const onInit = useCallback(async () => {
    if (!root) return
    setPhase({ kind: 'working', label: 'Initializing repository…' })
    try {
      const res = await gitInitRepo(root)
      setPhase({ kind: 'idle' })
      await refreshStatus()
      toast(
        res.createdGitignore
          ? 'Initialized repository and added a .gitignore.'
          : 'Initialized repository.',
        'info'
      )
    } catch (err) {
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }, [root, gitInitRepo, refreshStatus, toast])

  const onIgnore = useCallback(
    async (patterns: string[]) => {
      try {
        await addToGitignore(patterns, dir ?? undefined)
        toast(`Now ignoring ${patterns.join(', ')}.`, 'info')
        await refreshStatus()
        // Re-triage so the ignored files drop out of the plan.
        await onSync()
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error')
      }
    },
    [addToGitignore, dir, toast, refreshStatus, onSync]
  )

  if (!root) {
    return (
      <aside className="git-panel" aria-label="Sync">
        <div className="git-panel-header">
          <span className="sidebar-title">Sync</span>
        </div>
        <div className="sidebar-empty">Open a folder to sync your work.</div>
      </aside>
    )
  }

  // Folder isn't a git repo yet — offer to initialize one.
  if (git && !git.isRepo) {
    return (
      <aside className="git-panel" aria-label="Sync">
        <div className="git-panel-header">
          <span className="sidebar-title">Sync</span>
        </div>
        <div className="git-panel-body">
          <div className="git-init">
            <div className="git-init-title">This folder isn’t tracked yet</div>
            <p className="git-init-hint">
              Start tracking your work so you can save versions of it and sync. We’ll add a sensible
              ignore list for things that shouldn’t be saved.
            </p>
            <div className="git-actions">
              <button
                className="script-btn script-run"
                disabled={phase.kind === 'working'}
                onClick={() => void onInit()}
              >
                {phase.kind === 'working' ? 'Starting…' : 'Start tracking'}
              </button>
            </div>
            {phase.kind === 'error' ? <div className="git-error">{phase.message}</div> : null}
          </div>
        </div>
      </aside>
    )
  }

  const changes = git ? flattenChanges(git) : []
  const busy = phase.kind === 'working'

  return (
    <aside className="git-panel" aria-label="Sync">
      <div className="git-panel-header">
        <span className="sidebar-title">Sync</span>
        {git?.branch ? <span className="git-branch">{git.branch}</span> : null}
        <button
          className="sidebar-icon-btn git-refresh"
          onClick={() => {
            void refreshStatus()
            void refreshWorktrees()
          }}
          title="Refresh"
          aria-label="Refresh"
        >
          ↻
        </button>
      </div>

      {/* Target switcher — only once "Run all" has left card worktrees behind.
          Each card branch holds uncommitted agent work until it's synced. */}
      {worktrees.length > 0 ? (
        <div className="git-targets" role="group" aria-label="What to sync">
          <button
            type="button"
            className={`git-target ${target === null ? 'is-active' : ''}`}
            onClick={() => setTargetCardId(null)}
            title="Your own changes in the workspace"
          >
            Workspace
          </button>
          {worktrees.map((w) => (
            <button
              key={w.cardId}
              type="button"
              className={`git-target ${target?.cardId === w.cardId ? 'is-active' : ''}`}
              onClick={() => setTargetCardId(w.cardId)}
              title={`Agent work for "${branchLabel(w)}" on ${w.branch ?? 'its own branch'} — ${
                w.changeCount
              } change(s) waiting`}
            >
              {branchLabel(w)}
              {w.changeCount > 0 ? <span className="git-target-count">{w.changeCount}</span> : null}
            </button>
          ))}
        </div>
      ) : null}

      <div className="git-tabs" role="tablist">
        <button
          className={`git-tab ${tab === 'changes' ? 'is-active' : ''}`}
          role="tab"
          aria-selected={tab === 'changes'}
          onClick={() => setTab('changes')}
        >
          Changes
        </button>
        <button
          className={`git-tab ${tab === 'history' ? 'is-active' : ''}`}
          role="tab"
          aria-selected={tab === 'history'}
          onClick={() => setTab('history')}
        >
          History
        </button>
      </div>

      <div className="git-panel-body">
        {tab === 'history' ? (
          <HistoryView
            commits={commits}
            error={historyError}
            onRefresh={() => setHistoryNonce((n) => n + 1)}
          />
        ) : (
          <>
            {statusError ? <div className="git-error">{statusError}</div> : null}

            {/* Plain change list — what's different since the last save. */}
            <section className="git-section">
              <div className="git-section-title">
                <span>Changes ({changes.length})</span>
              </div>
              {changes.length === 0 ? (
                <div className="sidebar-empty">
                  {target
                    ? 'This task’s work is saved — nothing left to sync.'
                    : 'Everything’s saved — nothing to sync.'}
                </div>
              ) : (
                <ul
                  className="git-file-list"
                  onKeyDown={(e) => {
                    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
                    e.preventDefault()
                    // Move relative to the focused row, falling back to the file
                    // whose diff is currently open.
                    const focused = rowRefs.current.findIndex((el) => el === document.activeElement)
                    const current =
                      focused >= 0 ? focused : changes.findIndex((c) => c.path === state.diffPath)
                    const delta = e.key === 'ArrowDown' ? 1 : -1
                    const next = Math.min(changes.length - 1, Math.max(0, current + delta))
                    if (next === current || !changes[next]) return
                    rowRefs.current[next]?.focus()
                    void showFileDiff(changes[next].path, dir ?? undefined)
                  }}
                >
                  {changes.map((c, idx) => {
                    const active = state.view === 'diff' && state.diffPath === c.path
                    return (
                      <li key={c.path}>
                        <button
                          type="button"
                          ref={(el) => {
                            rowRefs.current[idx] = el
                          }}
                          className={`git-file-row ${active ? 'is-active' : ''}`}
                          title={`${c.path} — click to view changes`}
                          onClick={() => void showFileDiff(c.path, dir ?? undefined)}
                        >
                          <span className={`git-file-badge git-verb-${c.verb}`}>{c.verb[0]}</span>
                          <span className="git-file-path">{c.path}</span>
                          <span className="git-file-kind">{c.verb}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>

            {phase.kind === 'working' ? <div className="git-working">{phase.label}</div> : null}

            {phase.kind === 'error' ? (
              <div className="git-error">
                {phase.message}
                <div className="git-actions">
                  <button className="script-btn" onClick={() => setPhase({ kind: 'idle' })}>
                    Dismiss
                  </button>
                </div>
              </div>
            ) : null}

            {phase.kind === 'blocked' ? (
              <CoverageBlock
                report={phase.report}
                onFix={() => void syncDiagrams()}
                onRecheck={() => void onSync()}
              />
            ) : null}

            {phase.kind === 'done' ? (
              <SyncDone
                commits={phase.commits}
                sync={phase.sync}
                onDismiss={() => setPhase({ kind: 'idle' })}
              />
            ) : null}

            {phase.kind === 'plan' ? (
              <PlanReview
                plan={phase.plan}
                onCommit={() => void commitPlan(phase.plan)}
                onIgnore={(p) => void onIgnore(p)}
                onAdjust={(note) => void onSync(note)}
                onCancel={() => setPhase({ kind: 'idle' })}
              />
            ) : null}

            {/* The one button. Hidden while a plan/done screen is showing. */}
            {phase.kind === 'idle' || phase.kind === 'working' || phase.kind === 'error' ? (
              <div className="git-actions">
                <button
                  className="script-btn script-run git-sync-btn"
                  disabled={changes.length === 0 || busy}
                  onClick={() => void onSync()}
                >
                  {busy ? 'Working…' : 'Sync'}
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </aside>
  )
}

function PlanReview({
  plan,
  onCommit,
  onIgnore,
  onAdjust,
  onCancel
}: {
  plan: SyncPlan
  onCommit: () => void
  onIgnore: (patterns: string[]) => void
  onAdjust: (note: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [note, setNote] = useState('')
  const submitNote = (): void => {
    const trimmed = note.trim()
    if (!trimmed) return
    setNote('')
    onAdjust(trimmed)
  }

  const multi = plan.groups.length > 1
  const hasGroups = plan.groups.length > 0

  return (
    <div className="git-plan">
      {plan.summary ? <p className="git-plan-summary">{plan.summary}</p> : null}

      {plan.ignore.length > 0 ? (
        <div className="git-plan-ignore">
          <div className="git-plan-ignore-title">Probably shouldn’t be saved</div>
          {plan.ignore.map((i) => (
            <div key={i.pattern} className="git-ignore-row">
              <div className="git-ignore-text">
                <span className="git-ignore-pattern">{i.pattern}</span>
                <span className="git-ignore-reason">{i.reason}</span>
              </div>
              <button className="script-btn" onClick={() => onIgnore([i.pattern])}>
                Ignore
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {hasGroups ? (
        <div className="git-plan-groups">
          <div className="git-plan-groups-title">
            {multi ? `${plan.groups.length} commits` : 'One commit'}
          </div>
          {plan.groups.map((g, idx) => (
            <div key={idx} className="git-plan-card">
              <div className="git-plan-card-subject">{g.subject}</div>
              {g.body ? <div className="git-plan-card-body">{g.body}</div> : null}
              <div className="git-plan-card-files">
                {g.paths.map((p) => (
                  <span key={p} className="git-plan-card-file" title={p}>
                    {p}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="git-plan-summary">
          Nothing here needs saving once the files above are ignored.
        </p>
      )}

      <div className="git-plan-adjust">
        <input
          className="git-subject-input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submitNote()
            }
          }}
          placeholder="Want it different? e.g. “keep it all in one commit”"
          spellCheck={false}
        />
        {note.trim() ? (
          <button className="script-btn" onClick={submitNote}>
            Ask
          </button>
        ) : null}
      </div>

      <div className="git-actions">
        {hasGroups ? (
          <button className="script-btn script-run" onClick={onCommit}>
            {multi ? `Save all ${plan.groups.length}` : 'Save'}
          </button>
        ) : null}
        <button className="script-btn" onClick={onCancel}>
          {hasGroups ? 'Cancel' : 'Close'}
        </button>
      </div>
    </div>
  )
}

// Plain-language summary of the backup (push) step for the done screen.
function backupStatus(sync: GitSyncResult): { title: string; note: string; kind: 'ok' | 'warn' } {
  if (sync.pushed) {
    return { title: '✓ Saved and backed up online', note: '', kind: 'ok' }
  }
  if (!sync.remote) {
    return {
      title: '✓ Saved on this computer',
      note: 'Connect this project to GitHub to back your work up online.',
      kind: 'ok'
    }
  }
  if (sync.conflict) {
    return {
      title: '✓ Saved on this computer',
      note: 'Someone else changed things online. Your work is safe here — ask the agent to help merge it before backing up.',
      kind: 'warn'
    }
  }
  return {
    title: '✓ Saved on this computer',
    note: 'Couldn’t reach GitHub just now — we’ll back it up next time you sync.',
    kind: 'warn'
  }
}

function SyncDone({
  commits,
  sync,
  onDismiss
}: {
  commits: Array<{ subject: string; sha: string }>
  sync: GitSyncResult
  onDismiss: () => void
}): React.JSX.Element {
  const status = backupStatus(sync)
  return (
    <div className="git-done">
      <div className="git-done-title">{status.title}</div>
      <div className="git-done-count">
        {commits.length === 1 ? '1 commit' : `${commits.length} commits`}
      </div>
      <ul className="git-done-list">
        {commits.map((c) => (
          <li key={c.sha} className="git-done-row">
            <span className="git-done-sha">{c.sha.slice(0, 7)}</span>
            <span className="git-done-subject">{c.subject}</span>
          </li>
        ))}
      </ul>
      {status.note ? (
        <p className={`git-done-note ${status.kind === 'warn' ? 'is-warn' : ''}`}>{status.note}</p>
      ) : null}
      <div className="git-actions">
        <button className="script-btn" onClick={onDismiss}>
          Done
        </button>
      </div>
    </div>
  )
}

function HistoryView({
  commits,
  error,
  onRefresh
}: {
  commits: GitCommitEntry[] | null
  error: string | null
  onRefresh: () => void
}): React.JSX.Element {
  return (
    <div className="git-history">
      <div className="git-history-header">
        <span className="git-section-title">History</span>
        <button
          className="git-stage-all"
          onClick={onRefresh}
          title="Reload history"
          aria-label="Reload history"
        >
          Refresh
        </button>
      </div>
      {error ? <div className="git-error">{error}</div> : null}
      {commits === null ? (
        <div className="git-working">Loading history…</div>
      ) : commits.length === 0 ? (
        <div className="sidebar-empty">No saved versions yet.</div>
      ) : (
        <ul className="git-commit-list">
          {commits.map((c) => (
            <CommitRow key={c.hash} commit={c} />
          ))}
        </ul>
      )}
    </div>
  )
}

function CommitRow({ commit }: { commit: GitCommitEntry }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const hasBody = commit.body.trim().length > 0
  return (
    <li className="git-commit">
      <button
        className="git-commit-row"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={hasBody ? 'Show the prompt that produced this commit' : commit.subject}
      >
        <span className={`git-commit-caret ${open ? 'is-open' : ''}`}>▸</span>
        <span className="git-commit-subject">{commit.subject}</span>
        {commit.synthesized ? (
          <span className="git-commit-badge" title="Commit message synthesized by codeswim">
            prompt
          </span>
        ) : null}
      </button>
      <div className="git-commit-meta">
        <span className="git-commit-sha">{commit.shortHash}</span>
        <span className="git-commit-time" title={commit.date}>
          {relTime(commit.date)}
        </span>
      </div>
      {open && hasBody ? <pre className="git-commit-body">{commit.body}</pre> : null}
    </li>
  )
}

function CoverageBlock({
  report,
  onFix,
  onRecheck
}: {
  report: CoverageReport
  onFix: () => void
  onRecheck: () => void
}): React.JSX.Element {
  return (
    <div className="git-blocked">
      <div className="git-blocked-title">Hold on — your diagrams are out of date</div>
      <ul className="git-blocked-list">
        {report.brokenLinks.length > 0 ? <li>{report.brokenLinks.length} broken link(s)</li> : null}
        {report.orphanDiagrams.length > 0 ? (
          <li>{report.orphanDiagrams.length} orphan diagram(s)</li>
        ) : null}
        {report.uncoveredSources.length > 0 ? (
          <li>{report.uncoveredSources.length} uncovered source file(s)</li>
        ) : null}
        {report.mermaidIssues.length > 0 ? (
          <li>{report.mermaidIssues.length} mermaid issue(s)</li>
        ) : null}
      </ul>
      <p className="git-blocked-hint">
        Let the agent bring the diagrams back in line with the code, then sync again.
      </p>
      <div className="git-actions">
        <button className="script-btn script-run" onClick={onFix}>
          Fix with agent
        </button>
        <button className="script-btn" onClick={onRecheck}>
          Re-check
        </button>
      </div>
    </div>
  )
}
