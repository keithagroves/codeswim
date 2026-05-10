import { basename } from '../path-utils'
import { useStore } from '../store'

function label(path: string): string {
  const base = basename(path)
  return base.replace(/\.md$/i, '')
}

export function Breadcrumbs(): React.JSX.Element {
  const { state, popTo } = useStore()
  if (!state.currentFile) return <div className="breadcrumbs" />

  const stack = state.breadcrumbs

  return (
    <div className="breadcrumbs">
      {stack.map((path, i) => (
        <span key={`${i}-${path}`} style={{ display: 'inline-flex', alignItems: 'center' }}>
          <button className="breadcrumb" onClick={() => void popTo(i)} title={path}>
            {label(path)}
          </button>
          <span className="breadcrumb-separator"> / </span>
        </span>
      ))}
      <span className="breadcrumb current" title={state.currentFile}>
        {label(state.currentFile)}
      </span>
    </div>
  )
}
