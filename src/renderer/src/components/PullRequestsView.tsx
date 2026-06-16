import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../store'
import type { MergeMethod, PullRequest, PullRequestList } from '../../../preload/index.d'

type Filter = 'open' | 'closed' | 'all'

// Compact relative time ("3h ago"); full ISO on hover. Mirrors GitPanel's
// helper so the two history-style lists read the same.
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

export function PullRequestsView(): React.JSX.Element {
  const { state } = useStore()
  const root = state.rootPath
  const [filter, setFilter] = useState<Filter>('open')
  const [result, setResult] = useState<PullRequestList | null>(null)
  const [loading, setLoading] = useState(false)
  const [nonce, setNonce] = useState(0)

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  // Inlined as an async IIFE (rather than a synchronous setState in the effect
  // body) so the loading flag and result land after an await — keeps the effect
  // off the cascading-render path, matching GitPanel's status load.
  useEffect(() => {
    if (!root) return
    let cancelled = false
    void (async () => {
      setLoading(true)
      let res: PullRequestList
      try {
        res = await window.api.listPullRequests(root, filter)
      } catch (err) {
        res = {
          status: 'error',
          slug: null,
          pulls: [],
          error: err instanceof Error ? err.message : String(err)
        }
      }
      if (!cancelled) {
        setResult(res)
        setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [root, filter, nonce])

  const pulls = result?.pulls ?? []

  return (
    <div className="pr-view">
      <div className="pr-toolbar">
        <div className="pr-title-block">
          <div className="pr-title-row">
            <h1>Pull requests</h1>
            {loading ? <span className="pr-save-state">Loading…</span> : null}
          </div>
          {result?.slug ? <div className="pr-subtitle">{result.slug}</div> : null}
        </div>
        <div className="pr-toolbar-actions">
          <div className="pr-filter" role="tablist" aria-label="Pull request state">
            {(['open', 'closed', 'all'] as Filter[]).map((f) => (
              <button
                key={f}
                role="tab"
                aria-selected={filter === f}
                className={`pr-filter-btn ${filter === f ? 'is-active' : ''}`}
                onClick={() => setFilter(f)}
              >
                {f[0].toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
          <button className="secondary" onClick={refresh} disabled={loading}>
            Refresh
          </button>
        </div>
      </div>

      <div className="pr-body">
        <PullRequestsContent
          loading={loading}
          result={result}
          pulls={pulls}
          filter={filter}
          onMerged={refresh}
        />
      </div>
    </div>
  )
}

function PullRequestsContent({
  loading,
  result,
  pulls,
  filter,
  onMerged
}: {
  loading: boolean
  result: PullRequestList | null
  pulls: PullRequest[]
  filter: Filter
  onMerged: () => void
}): React.JSX.Element {
  if (!result && loading) {
    return <div className="pr-message">Loading pull requests…</div>
  }
  if (result?.status === 'not-github') {
    return (
      <div className="pr-message">
        This workspace isn’t connected to a GitHub repository, so there are no pull requests to
        show.
      </div>
    )
  }
  if (result?.status === 'no-auth') {
    return (
      <div className="pr-message">
        Sign in to GitHub to see pull requests for this repository. Open the chat panel’s settings
        to connect your account.
      </div>
    )
  }
  if (result?.status === 'error') {
    return (
      <div className="pr-message pr-message-error">Couldn’t load pull requests: {result.error}</div>
    )
  }
  if (pulls.length === 0) {
    return (
      <div className="pr-message">
        No {filter === 'all' ? '' : filter} pull requests{filter === 'all' ? '' : ' right now'}.
      </div>
    )
  }
  return (
    <ul className="pr-list">
      {pulls.map((pr) => (
        <PullRequestRow key={pr.number} pr={pr} onMerged={onMerged} />
      ))}
    </ul>
  )
}

// Per-row merge flow. Merging is hard to reverse, so the button never merges on
// a single click: it opens an inline confirm with a merge-method choice.
type MergeState =
  | { kind: 'idle' }
  | { kind: 'confirming' }
  | { kind: 'merging' }
  | { kind: 'error'; message: string }

const MERGE_METHODS: Array<{ value: MergeMethod; label: string }> = [
  { value: 'merge', label: 'Merge commit' },
  { value: 'squash', label: 'Squash' },
  { value: 'rebase', label: 'Rebase' }
]

function PullRequestRow({
  pr,
  onMerged
}: {
  pr: PullRequest
  onMerged: () => void
}): React.JSX.Element {
  const { state, toast, reviewPullRequest } = useStore()
  const root = state.rootPath
  const [merge, setMerge] = useState<MergeState>({ kind: 'idle' })
  const [method, setMethod] = useState<MergeMethod>('merge')
  const stateLabel = pr.state === 'closed' ? 'closed' : pr.draft ? 'draft' : 'open'
  // Only open, non-draft PRs are mergeable from here; GitHub would reject the
  // rest anyway, so we don't offer the button.
  const canMerge = pr.state === 'open' && !pr.draft

  const doMerge = useCallback(async () => {
    if (!root) return
    setMerge({ kind: 'merging' })
    const res = await window.api.mergePullRequest(root, pr.number, method)
    if (res.status === 'merged') {
      toast(`Merged #${pr.number}.`, 'info')
      onMerged()
      return
    }
    const reason =
      res.status === 'no-auth'
        ? 'You need write access (sign in to GitHub) to merge this.'
        : res.status === 'blocked'
          ? res.message || 'GitHub won’t merge this yet (conflicts, checks, or branch rules).'
          : res.message || 'Merge failed.'
    setMerge({ kind: 'error', message: reason })
    toast(`Couldn’t merge #${pr.number}: ${reason}`, 'error')
  }, [root, pr.number, method, toast, onMerged])

  return (
    <li className="pr-row">
      <div className="pr-row-inner">
        <button
          type="button"
          className="pr-row-btn"
          title={`${pr.title} — open on GitHub`}
          onClick={() => window.open(pr.url, '_blank')}
        >
          <span className={`pr-state pr-state-${stateLabel}`} aria-label={stateLabel}>
            {stateLabel === 'closed' ? '⊘' : stateLabel === 'draft' ? '◷' : '⇡'}
          </span>
          <div className="pr-row-main">
            <div className="pr-row-title">
              <span className="pr-row-titletext">{pr.title}</span>
              <span className="pr-row-number">#{pr.number}</span>
            </div>
            <div className="pr-row-meta">
              {pr.author ? <span className="pr-row-author">{pr.author}</span> : null}
              <span title={pr.updatedAt}>updated {relTime(pr.updatedAt)}</span>
              <span className="pr-row-branch" title={`${pr.headRef} → ${pr.baseRef}`}>
                {pr.headRef} → {pr.baseRef}
              </span>
              {pr.comments > 0 ? <span className="pr-row-comments">💬 {pr.comments}</span> : null}
            </div>
          </div>
        </button>

        <div className="pr-row-actions">
          <button
            type="button"
            className="pr-review-btn"
            title="Open the agent and have it review this PR"
            onClick={() => void reviewPullRequest(pr)}
          >
            Review
          </button>
          {canMerge ? (
            <>
              {merge.kind === 'idle' || merge.kind === 'error' ? (
                <button
                  type="button"
                  className="pr-merge-btn"
                  onClick={() => setMerge({ kind: 'confirming' })}
                >
                  Merge
                </button>
              ) : null}
              {merge.kind === 'merging' ? (
                <button type="button" className="pr-merge-btn" disabled>
                  Merging…
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      {merge.kind === 'confirming' ? (
        <div className="pr-merge-confirm">
          <span className="pr-merge-confirm-text">
            Merge #{pr.number} into {pr.baseRef}?
          </span>
          <select
            className="pr-merge-method"
            value={method}
            onChange={(e) => setMethod(e.target.value as MergeMethod)}
            aria-label="Merge method"
          >
            {MERGE_METHODS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <button type="button" className="pr-merge-btn pr-merge-go" onClick={() => void doMerge()}>
            Confirm merge
          </button>
          <button
            type="button"
            className="pr-merge-cancel"
            onClick={() => setMerge({ kind: 'idle' })}
          >
            Cancel
          </button>
        </div>
      ) : null}

      {merge.kind === 'error' ? <div className="pr-merge-error">{merge.message}</div> : null}
    </li>
  )
}
