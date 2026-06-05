import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../store'
import type { GitStatus } from '../../../preload/index.d'
import { runCoverage } from '../coverage/run'
import type { CoverageReport } from '../coverage/coverage'
import { composeCommitBody, buildTrailers } from '../commit/synthesize'

type Phase =
  | { kind: 'idle' }
  | { kind: 'working'; label: string }
  | { kind: 'blocked'; report: CoverageReport }
  | { kind: 'review'; subject: string; body: string }
  | { kind: 'error'; message: string }

function coverageIssueCount(r: CoverageReport): number {
  return (
    r.brokenLinks.length +
    r.orphanDiagrams.length +
    r.uncoveredSources.length +
    r.mermaidIssues.length
  )
}

// Single-letter status from the porcelain index code, for the staged list.
function codeLabel(code: string): string {
  switch (code) {
    case 'A':
      return 'added'
    case 'M':
      return 'modified'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    default:
      return code
  }
}

export function GitPanel(): React.JSX.Element {
  const { state, toast, synthesizeCommitMessage, syncDiagrams } = useStore()
  const root = state.rootPath
  const [git, setGit] = useState<GitStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })

  const refreshStatus = useCallback(async () => {
    // When there's no workspace the panel renders its empty state and never
    // reads `git`, so we skip rather than reset synchronously here.
    if (!root) return
    try {
      const s = await window.api.gitStatus(root)
      setGit(s)
      setStatusError(null)
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err))
      setGit(null)
    }
  }, [root])

  // Load on mount / when the workspace changes, and whenever the file tree
  // shifts (stage/unstage shows up as changes the watcher already reports).
  // Inlined (rather than calling refreshStatus) so the only setState calls
  // happen after an await — keeps the effect off the cascading-render path.
  useEffect(() => {
    if (!root) return
    let cancelled = false
    void (async () => {
      try {
        const s = await window.api.gitStatus(root)
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
  }, [root, state.tree])

  const onCompose = useCallback(async () => {
    if (!root) return
    // 1. Coverage gates first — never synthesize for a commit we'd refuse.
    setPhase({ kind: 'working', label: 'Checking diagram coverage…' })
    let report: CoverageReport
    try {
      report = await runCoverage(root)
    } catch (err) {
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      return
    }
    // Only enforce the diagram gate for codeswim-style repos — ones that
    // actually have diagrams to keep aligned. A plain project (no diagrams,
    // e.g. right after `git init`) has nothing to drift, so skip the block.
    if (report.totals.diagrams > 0 && coverageIssueCount(report) > 0) {
      setPhase({ kind: 'blocked', report })
      return
    }
    // 2. Coverage clean — synthesize the prompt from the staged diff.
    setPhase({ kind: 'working', label: 'Reading staged diff…' })
    let diff: string
    try {
      diff = await window.api.gitStagedDiff(root)
    } catch (err) {
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      return
    }
    if (!diff.trim()) {
      setPhase({ kind: 'error', message: 'Nothing staged — stage changes before composing.' })
      return
    }
    setPhase({ kind: 'working', label: 'Synthesizing commit prompt…' })
    try {
      const msg = await synthesizeCommitMessage(diff)
      setPhase({ kind: 'review', subject: msg.subject, body: msg.body })
    } catch (err) {
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }, [root, synthesizeCommitMessage])

  const onCommit = useCallback(
    async (subject: string, body: string) => {
      if (!root) return
      const trimmed = subject.trim()
      if (!trimmed) {
        toast('Commit subject is empty.', 'error')
        return
      }
      setPhase({ kind: 'working', label: 'Committing…' })
      try {
        const fullBody = composeCommitBody(body, { coveragePassed: true })
        const sha = await window.api.gitCommit(root, trimmed, fullBody)
        toast(`Committed ${sha.slice(0, 7)}`, 'info')
        setPhase({ kind: 'idle' })
        void refreshStatus()
      } catch (err) {
        setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    },
    [root, toast, refreshStatus]
  )

  const onInit = useCallback(async () => {
    if (!root) return
    setPhase({ kind: 'working', label: 'Initializing repository…' })
    try {
      const res = await window.api.gitInit(root)
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
  }, [root, refreshStatus, toast])

  const onStageAll = useCallback(async () => {
    if (!root) return
    try {
      await window.api.gitStageAll(root)
      await refreshStatus()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }, [root, refreshStatus, toast])

  if (!root) {
    return (
      <aside className="git-panel" aria-label="Commit">
        <div className="git-panel-header">
          <span className="sidebar-title">Commit</span>
        </div>
        <div className="sidebar-empty">Open a folder to commit.</div>
      </aside>
    )
  }

  // Folder isn't a git repo yet — offer to initialize one, then the normal
  // flow (stage → compose → commit) takes over for the first commit.
  if (git && !git.isRepo) {
    return (
      <aside className="git-panel" aria-label="Commit">
        <div className="git-panel-header">
          <span className="sidebar-title">Commit</span>
        </div>
        <div className="git-panel-body">
          <div className="git-init">
            <div className="git-init-title">This folder isn’t a git repository</div>
            <p className="git-init-hint">
              Initialize one to start tracking changes, then create your first
              commit through the same compose flow.
            </p>
            <div className="git-actions">
              <button
                className="script-btn script-run"
                disabled={phase.kind === 'working'}
                onClick={() => void onInit()}
              >
                {phase.kind === 'working' ? 'Initializing…' : 'Initialize repository'}
              </button>
            </div>
            {phase.kind === 'error' ? <div className="git-error">{phase.message}</div> : null}
          </div>
        </div>
      </aside>
    )
  }

  const stagedCount = git?.staged.length ?? 0
  const unstaged = git?.unstaged ?? []
  const untracked = git?.untracked ?? []
  const changeCount = unstaged.length + untracked.length

  return (
    <aside className="git-panel" aria-label="Commit">
      <div className="git-panel-header">
        <span className="sidebar-title">Commit</span>
        {git?.branch ? <span className="git-branch">{git.branch}</span> : null}
        <button
          className="sidebar-icon-btn git-refresh"
          onClick={() => void refreshStatus()}
          title="Refresh status"
          aria-label="Refresh status"
        >
          ↻
        </button>
      </div>

      <div className="git-panel-body">
        {statusError ? <div className="git-error">{statusError}</div> : null}

        <section className="git-section">
          <div className="git-section-title">Staged ({stagedCount})</div>
          {stagedCount === 0 ? (
            <div className="sidebar-empty">
              Stage changes in your editor or terminal, then compose a commit.
            </div>
          ) : (
            <ul className="git-file-list">
              {git!.staged.map((f) => (
                <li key={f.path} className="git-file-row" title={f.path}>
                  <span className={`git-file-badge git-badge-${f.index}`}>{f.index}</span>
                  <span className="git-file-path">{f.path}</span>
                  <span className="git-file-kind">{codeLabel(f.index)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {changeCount > 0 ? (
          <section className="git-section">
            <div className="git-section-title">
              <span>Changes ({changeCount})</span>
              <button className="git-stage-all" onClick={() => void onStageAll()}>
                Stage all
              </button>
            </div>
            <ul className="git-file-list">
              {unstaged.map((f) => (
                <li key={`u:${f.path}`} className="git-file-row" title={f.path}>
                  <span className={`git-file-badge git-badge-${f.worktree}`}>{f.worktree}</span>
                  <span className="git-file-path">{f.path}</span>
                  <span className="git-file-kind">{codeLabel(f.worktree)}</span>
                </li>
              ))}
              {untracked.map((p) => (
                <li key={`t:${p}`} className="git-file-row" title={p}>
                  <span className="git-file-badge">?</span>
                  <span className="git-file-path">{p}</span>
                  <span className="git-file-kind">untracked</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

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
            onFix={() => {
              void syncDiagrams()
            }}
            onRecheck={() => void onCompose()}
          />
        ) : null}

        {phase.kind === 'review' ? (
          <ReviewForm
            initialSubject={phase.subject}
            initialBody={phase.body}
            onCommit={onCommit}
            onRegenerate={() => void onCompose()}
            onCancel={() => setPhase({ kind: 'idle' })}
          />
        ) : null}

        {phase.kind === 'idle' || phase.kind === 'error' ? (
          <div className="git-actions">
            <button
              className="script-btn script-run"
              disabled={stagedCount === 0}
              onClick={() => void onCompose()}
            >
              Compose commit
            </button>
          </div>
        ) : null}
      </div>
    </aside>
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
      <div className="git-blocked-title">Commit blocked — diagrams are out of sync</div>
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
        Align the diagrams with the code, then re-check. The agent can fix the drift for you.
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

function ReviewForm({
  initialSubject,
  initialBody,
  onCommit,
  onRegenerate,
  onCancel
}: {
  initialSubject: string
  initialBody: string
  onCommit: (subject: string, body: string) => void
  onRegenerate: () => void
  onCancel: () => void
}): React.JSX.Element {
  const [subject, setSubject] = useState(initialSubject)
  const [body, setBody] = useState(initialBody)

  return (
    <div className="git-review">
      <div className="git-review-label">Commit message (edit before committing)</div>
      <input
        className="git-subject-input"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder="Subject line"
        spellCheck={false}
      />
      <textarea
        className="git-body-input"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Body — the prompt that regenerates this change"
        rows={10}
        spellCheck={false}
      />
      <div className="git-trailers">
        <div className="git-trailers-label">Appended automatically</div>
        <pre className="git-trailers-pre">{buildTrailers({ coveragePassed: true })}</pre>
      </div>
      <div className="git-actions">
        <button
          className="script-btn script-run"
          disabled={!subject.trim()}
          onClick={() => onCommit(subject, body)}
        >
          Commit
        </button>
        <button className="script-btn" onClick={onRegenerate}>
          Regenerate
        </button>
        <button className="script-btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}
