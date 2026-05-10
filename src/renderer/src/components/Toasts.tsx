import { useStore } from '../store'

export function Toasts(): React.JSX.Element {
  const { state } = useStore()
  return (
    <div className="toast-container">
      {state.toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : ''}`}>
          {t.message}
        </div>
      ))}
    </div>
  )
}
