import { useMemo } from 'react'
import { useStore } from '../store'

type LineKind = 'meta' | 'hunk' | 'add' | 'del' | 'context'

function classifyLine(line: string): LineKind {
  if (line.startsWith('@@')) return 'hunk'
  if (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('rename ') ||
    line.startsWith('similarity ') ||
    line.startsWith('old mode') ||
    line.startsWith('new mode') ||
    line.startsWith('Binary files')
  ) {
    return 'meta'
  }
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'context'
}

// Renders a raw unified diff with per-line coloring. The diff itself is loaded
// into app state by showFileDiff (Sync → click a changed file).
export function DiffView(): React.JSX.Element {
  const { state, hideDiff } = useStore()
  const { diffPath, diffContent, diffLoading } = state

  const lines = useMemo(() => {
    if (!diffContent) return []
    // Drop a single trailing newline so we don't render a blank final row.
    const body = diffContent.endsWith('\n') ? diffContent.slice(0, -1) : diffContent
    return body.split('\n').map((text, i) => ({ id: i, kind: classifyLine(text), text }))
  }, [diffContent])

  return (
    <div className="diff-view">
      <div className="diff-view-header">
        <span className="diff-view-path" title={diffPath ?? undefined}>
          {diffPath ?? 'Diff'}
        </span>
        <button className="script-btn" onClick={hideDiff} title="Close diff">
          Close
        </button>
      </div>
      <div className="diff-view-body">
        {diffLoading ? (
          <div className="diff-view-empty">Loading diff…</div>
        ) : lines.length === 0 ? (
          <div className="diff-view-empty">
            No textual changes to show — this file may be new, binary, or unchanged.
          </div>
        ) : (
          <pre className="diff-view-pre">
            {lines.map((l) => (
              <div key={l.id} className={`diff-line diff-line-${l.kind}`}>
                {l.text || ' '}
              </div>
            ))}
          </pre>
        )}
      </div>
    </div>
  )
}
