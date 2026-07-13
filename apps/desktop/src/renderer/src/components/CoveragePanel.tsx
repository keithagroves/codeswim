import { useCallback, useEffect, useState } from 'react'
import { analyzeCoverage, type CoverageReport, type FileInfo } from '@codeswim/coverage'
import type { TreeNode } from '@codeswim/contract'
import { relativeToRoot, toPosix } from '../path-utils'
import { useStore } from '../store'

// Sidebar section for diagram coverage: runs the @codeswim/coverage analysis
// over the open workspace and lists what's broken or missing. Everything runs
// renderer-side — the analysis is pure and the data comes through existing
// IPC (listMarkdown + readFile) plus the already-loaded file tree.

function flatten(nodes: TreeNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.kind === 'file') out.push(node.path)
    if (node.children) flatten(node.children, out)
  }
  return out
}

interface RunState {
  status: 'idle' | 'running' | 'done' | 'error'
  report?: CoverageReport
  message?: string
  at?: number
}

export function CoveragePanel(): React.JSX.Element {
  const { state, navigateAbsolute } = useStore()
  const [run, setRun] = useState<RunState>({ status: 'idle' })
  const rootPath = state.rootPath
  const tree = state.tree

  const runCheck = useCallback(async (): Promise<void> => {
    if (!rootPath) return
    setRun({ status: 'running' })
    try {
      const root = toPosix(rootPath).replace(/\/$/, '')
      const mdAbs = await window.api.listMarkdown(rootPath)
      const mdRel = mdAbs
        .map((f) => relativeToRoot(root, toPosix(f)))
        .filter((p): p is string => p !== null)

      // Diagrams need content (links are extracted from them); everything
      // else only needs to exist so link targets resolve.
      const files: FileInfo[] = await Promise.all(
        mdRel.map(async (path) => {
          try {
            return { path, content: await window.api.readFile(`${root}/${path}`) }
          } catch {
            return { path, content: '' }
          }
        })
      )
      const mdSet = new Set(mdRel)
      for (const path of flatten(tree ?? [])) {
        if (!mdSet.has(path)) files.push({ path, content: '' })
      }

      setRun({ status: 'done', report: analyzeCoverage(files), at: Date.now() })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setRun({ status: 'error', message })
    }
  }, [rootPath, tree])

  // Show the current state as soon as the section opens.
  useEffect(() => {
    void runCheck()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath])

  const open = (path: string): void => {
    void navigateAbsolute(path, true)
  }

  const report = run.status === 'done' ? run.report : undefined
  const pct =
    report && report.totals.sources > 0
      ? Math.round((report.totals.coveredSources / report.totals.sources) * 100)
      : null

  return (
    <aside className="coverage-panel" aria-label="Diagram coverage">
      <div className="coverage-panel-header">
        <span className="sidebar-title">Coverage</span>
        <button
          className="secondary coverage-run"
          onClick={() => void runCheck()}
          disabled={!rootPath || run.status === 'running'}
        >
          {run.status === 'running' ? 'Checking…' : 'Run check'}
        </button>
      </div>

      <div className="coverage-panel-body">
        {!rootPath ? (
          <div className="coverage-empty">Open a folder to check diagram coverage.</div>
        ) : run.status === 'error' ? (
          <div className="coverage-empty">Check failed: {run.message}</div>
        ) : !report ? (
          <div className="coverage-empty">Analyzing diagrams…</div>
        ) : (
          <>
            <div className="coverage-summary">
              {pct !== null ? (
                <>
                  <div className="coverage-meter" role="img" aria-label={`${pct}% covered`}>
                    <div className="coverage-meter-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="coverage-summary-line">
                    <strong>{pct}%</strong> of source files covered (
                    {report.totals.coveredSources}/{report.totals.sources})
                  </div>
                </>
              ) : (
                <div className="coverage-summary-line">No source files found.</div>
              )}
              <div className="coverage-summary-line coverage-muted">
                {report.totals.diagrams} diagrams · {report.totals.totalLinks} links · entry{' '}
                {report.entry ? (
                  <button className="coverage-link" onClick={() => open(report.entry!)}>
                    {report.entry}
                  </button>
                ) : (
                  'not found'
                )}
              </div>
            </div>

            <CoverageGroup
              title="Broken links"
              count={report.brokenLinks.length}
              emptyLabel="No broken links"
            >
              {report.brokenLinks.map((link, i) => (
                <li key={`${link.sourceFile}-${i}`}>
                  <button
                    className="coverage-item"
                    onClick={() => open(link.sourceFile)}
                    title={`${link.sourceFile}:${link.line} → ${link.target}`}
                  >
                    <span className="coverage-item-name">{link.target}</span>
                    <span className="coverage-item-path">
                      {link.sourceFile}:{link.line}
                    </span>
                  </button>
                </li>
              ))}
            </CoverageGroup>

            <CoverageGroup
              title="Orphan diagrams"
              count={report.orphanDiagrams.length}
              emptyLabel="Every diagram is reachable from the entry"
            >
              {report.orphanDiagrams.map((path) => (
                <PathItem key={path} path={path} onOpen={open} />
              ))}
            </CoverageGroup>

            <CoverageGroup
              title="Uncovered source files"
              count={report.uncoveredSources.length}
              emptyLabel="Every source file is linked from a diagram"
            >
              {report.uncoveredSources.map((path) => (
                <PathItem key={path} path={path} onOpen={open} />
              ))}
            </CoverageGroup>

            <CoverageGroup
              title="Mermaid issues"
              count={report.mermaidIssues.length}
              emptyLabel="No mermaid issues"
            >
              {report.mermaidIssues.map((issue, i) => (
                <li key={`${issue.sourceFile}-${i}`}>
                  <button
                    className="coverage-item"
                    onClick={() => open(issue.sourceFile)}
                    title={issue.message}
                  >
                    <span className="coverage-item-name">{issue.message}</span>
                    <span className="coverage-item-path">
                      {issue.sourceFile}:{issue.line}
                    </span>
                  </button>
                </li>
              ))}
            </CoverageGroup>
          </>
        )}
      </div>
    </aside>
  )
}

function CoverageGroup(props: {
  title: string
  count: number
  emptyLabel: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <details className="coverage-group" open={props.count > 0}>
      <summary>
        {props.title}
        <span className={`coverage-count ${props.count > 0 ? 'has-issues' : ''}`}>
          {props.count}
        </span>
      </summary>
      {props.count === 0 ? (
        <div className="coverage-empty">{props.emptyLabel}</div>
      ) : (
        <ul className="coverage-list">{props.children}</ul>
      )}
    </details>
  )
}

function PathItem(props: { path: string; onOpen: (path: string) => void }): React.JSX.Element {
  const name = props.path.split('/').at(-1) ?? props.path
  const dir = props.path.slice(0, props.path.length - name.length - 1)
  return (
    <li>
      <button className="coverage-item" onClick={() => props.onOpen(props.path)} title={props.path}>
        <span className="coverage-item-name">{name}</span>
        {dir ? <span className="coverage-item-path">{dir}</span> : null}
      </button>
    </li>
  )
}
