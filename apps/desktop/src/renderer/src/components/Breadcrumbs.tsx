import { useStore } from '../store'

function trimMd(name: string): string {
  return name.replace(/\.md$/i, '')
}

export function Breadcrumbs(): React.JSX.Element {
  const { state } = useStore()
  if (!state.currentFile) return <div className="breadcrumbs" />

  const segments = state.currentFile.split('/').filter(Boolean)
  const dirs = segments.slice(0, -1)
  const file = segments[segments.length - 1] ?? state.currentFile

  return (
    <div className="breadcrumbs">
      {dirs.map((seg, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center' }}>
          <span className="breadcrumb">{seg}</span>
          <span className="breadcrumb-separator"> / </span>
        </span>
      ))}
      <span className="breadcrumb current" title={state.currentFile}>
        {trimMd(file)}
      </span>
    </div>
  )
}
