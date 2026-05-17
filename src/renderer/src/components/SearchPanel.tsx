import { useMemo, useState } from 'react'
import { useStore } from '../store'
import type { TreeNode } from '../store'
import { basename } from '../path-utils'

function flatten(nodes: TreeNode[] | null): string[] {
  if (!nodes) return []
  const out: string[] = []
  const stack: TreeNode[] = [...nodes]
  while (stack.length > 0) {
    const node = stack.shift()!
    if (node.kind === 'file') out.push(node.path)
    if (node.children) stack.unshift(...node.children)
  }
  return out
}

// Match score: lower is better, null = no match. We bias toward matches in
// the file name over matches in the parent directory.
function score(query: string, path: string): number | null {
  const q = query.toLowerCase()
  const p = path.toLowerCase()
  const name = basename(p)
  if (!q) return null
  if (name.includes(q)) return name.indexOf(q) // name match: small numbers
  if (p.includes(q)) return 1000 + p.indexOf(q) // path match: bigger numbers
  return null
}

export function SearchPanel(): React.JSX.Element {
  const { state, navigateAbsolute } = useStore()
  const [query, setQuery] = useState('')

  const allFiles = useMemo(() => flatten(state.tree), [state.tree])
  const results = useMemo(() => {
    const trimmed = query.trim()
    if (!trimmed) return []
    const scored: Array<{ path: string; rank: number }> = []
    for (const path of allFiles) {
      const r = score(trimmed, path)
      if (r !== null) scored.push({ path, rank: r })
    }
    scored.sort((a, b) => a.rank - b.rank)
    return scored.slice(0, 100).map((s) => s.path)
  }, [query, allFiles])

  const onSelect = (path: string): void => {
    void navigateAbsolute(path, true)
  }

  return (
    <aside className="search-panel" aria-label="Search">
      <div className="search-panel-header">
        <span className="sidebar-title">Search</span>
      </div>
      <div className="search-panel-input-wrap">
        <input
          type="search"
          className="search-panel-input"
          placeholder="Search files by name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
          spellCheck={false}
        />
      </div>
      <div className="search-panel-results">
        {query.trim() === '' ? (
          <div className="search-panel-empty">Type to search files</div>
        ) : results.length === 0 ? (
          <div className="search-panel-empty">No matches</div>
        ) : (
          <ul>
            {results.map((path) => {
              const name = basename(path)
              const dir = path.slice(0, path.length - name.length - 1)
              return (
                <li key={path}>
                  <button className="search-result" onClick={() => onSelect(path)} title={path}>
                    <span className="search-result-name">{name}</span>
                    {dir ? <span className="search-result-dir">{dir}</span> : null}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </aside>
  )
}
