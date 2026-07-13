import { useCallback, useEffect, useState } from 'react'
import type { CoverageReport } from '@codeswim/coverage'
import { runCoverage } from '../coverage/run'
import { useStore } from '../store'

// Sidebar section for the audit → fix loop on diagram coverage. Shows the
// workspace's current state (via the shared runCoverage), lists only the
// groups that actually have issues, and hands the whole batch to the agent
// with one click (syncDiagrams — same flow GitPanel's drift banner uses).

const PREVIEW_COUNT = 10

interface RunState {
  status: 'idle' | 'running' | 'done' | 'error'
  report?: CoverageReport
  message?: string
}

function RefreshIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function CheckIcon(): React.JSX.Element {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8 12.5l2.7 2.7L16 9.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function CoveragePanel(): React.JSX.Element {
  const { state, navigateAbsolute, syncDiagrams } = useStore()
  const [run, setRun] = useState<RunState>({ status: 'idle' })
  const [fixing, setFixing] = useState(false)
  const rootPath = state.rootPath

  const runCheck = useCallback(async (): Promise<void> => {
    if (!rootPath) return
    setRun({ status: 'running' })
    try {
      setRun({ status: 'done', report: await runCoverage(rootPath) })
    } catch (err) {
      setRun({ status: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }, [rootPath])

  // Show the current state as soon as the section opens.
  useEffect(() => {
    void runCheck()
  }, [runCheck])

  const open = (path: string): void => {
    void navigateAbsolute(path, true)
  }

  const onFix = async (): Promise<void> => {
    setFixing(true)
    try {
      await syncDiagrams()
    } finally {
      setFixing(false)
    }
  }

  const report = run.status === 'done' ? run.report : undefined
  const issueCount = report
    ? report.brokenLinks.length +
      report.orphanDiagrams.length +
      report.uncoveredSources.length +
      report.mermaidIssues.length
    : 0
  const pct =
    report && report.totals.sources > 0
      ? Math.round((report.totals.coveredSources / report.totals.sources) * 100)
      : null

  return (
    <aside className="coverage-panel" aria-label="Diagram coverage">
      <div className="coverage-panel-header">
        <span className="sidebar-title">Coverage</span>
        <button
          className="coverage-refresh"
          onClick={() => void runCheck()}
          disabled={!rootPath || run.status === 'running'}
          title="Re-run coverage check"
          aria-label="Re-run coverage check"
        >
          <RefreshIcon />
        </button>
      </div>

      <div className="coverage-panel-body">
        {!rootPath ? (
          <div className="coverage-empty">Open a folder to check diagram coverage.</div>
        ) : run.status === 'error' ? (
          <div className="coverage-empty">Check failed: {run.message}</div>
        ) : !report ? (
          <div className="coverage-empty">Analyzing diagrams…</div>
        ) : issueCount === 0 ? (
          <div className="coverage-hero is-clean">
            <span className="coverage-hero-icon">
              <CheckIcon />
            </span>
            <div className="coverage-hero-title">Diagrams and code are in sync</div>
            <StatsLine report={report} onOpenEntry={open} />
          </div>
        ) : (
          <>
            <div className="coverage-hero">
              {pct !== null ? (
                <div className="coverage-meter" role="img" aria-label={`${pct}% covered`}>
                  <div className="coverage-meter-fill" style={{ width: `${pct}%` }} />
                </div>
              ) : null}
              <div className="coverage-hero-title">
                {issueCount} {issueCount === 1 ? 'issue' : 'issues'}
                {pct !== null ? (
                  <span className="coverage-muted"> · {pct}% of sources covered</span>
                ) : null}
              </div>
              <button className="coverage-fix" onClick={() => void onFix()} disabled={fixing}>
                {fixing ? 'Handing to agent…' : 'Fix with agent'}
              </button>
              <StatsLine report={report} onOpenEntry={open} />
            </div>

            <IssueGroup
              title="Broken links"
              items={report.brokenLinks.map((link, i) => ({
                key: `${link.sourceFile}:${link.line}:${i}`,
                primary: link.target,
                secondary: `${link.sourceFile}:${link.line}`,
                openPath: link.sourceFile,
                tooltip: `${link.sourceFile}:${link.line} → ${link.target}`
              }))}
              onOpen={open}
            />
            <IssueGroup
              title="Orphan diagrams"
              hint="Not reachable from the entry diagram"
              items={report.orphanDiagrams.map((path) => pathItem(path))}
              onOpen={open}
            />
            <IssueGroup
              title="Uncovered sources"
              hint="No diagram links these files"
              items={report.uncoveredSources.map((path) => pathItem(path))}
              onOpen={open}
            />
            <IssueGroup
              title="Mermaid issues"
              items={report.mermaidIssues.map((issue, i) => ({
                key: `${issue.sourceFile}:${issue.line}:${i}`,
                primary: issue.message,
                secondary: `${issue.sourceFile}:${issue.line}`,
                openPath: issue.sourceFile,
                tooltip: issue.message
              }))}
              onOpen={open}
            />
          </>
        )}
      </div>
    </aside>
  )
}

function StatsLine(props: {
  report: CoverageReport
  onOpenEntry: (path: string) => void
}): React.JSX.Element {
  const { totals, entry } = props.report
  return (
    <div className="coverage-stats">
      {totals.coveredSources}/{totals.sources} sources · {totals.diagrams} diagrams ·{' '}
      {entry ? (
        <button className="coverage-link" onClick={() => props.onOpenEntry(entry)}>
          {entry}
        </button>
      ) : (
        'no entry diagram'
      )}
    </div>
  )
}

interface IssueItem {
  key: string
  primary: string
  secondary?: string
  openPath: string
  tooltip: string
}

function pathItem(path: string): IssueItem {
  const name = path.split('/').at(-1) ?? path
  const dir = path.slice(0, path.length - name.length - 1)
  return { key: path, primary: name, secondary: dir || undefined, openPath: path, tooltip: path }
}

// A flat issue section: rendered only when it has items, previewing the
// first PREVIEW_COUNT with an explicit expand — long lists were the main
// source of clutter in the first cut of this panel.
function IssueGroup(props: {
  title: string
  hint?: string
  items: IssueItem[]
  onOpen: (path: string) => void
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  if (props.items.length === 0) return null
  const shown = expanded ? props.items : props.items.slice(0, PREVIEW_COUNT)
  const hidden = props.items.length - shown.length

  return (
    <section className="coverage-group">
      <div className="coverage-group-label" title={props.hint}>
        {props.title}
        <span className="coverage-count">{props.items.length}</span>
      </div>
      <ul className="coverage-list">
        {shown.map((item) => (
          <li key={item.key}>
            <button
              className="coverage-item"
              onClick={() => props.onOpen(item.openPath)}
              title={item.tooltip}
            >
              <span className="coverage-item-name">{item.primary}</span>
              {item.secondary ? (
                <span className="coverage-item-path">{item.secondary}</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <button className="coverage-more" onClick={() => setExpanded(true)}>
          Show {hidden} more
        </button>
      ) : null}
    </section>
  )
}
