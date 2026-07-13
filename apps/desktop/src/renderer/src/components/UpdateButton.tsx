import { useEffect, useState } from 'react'
import type { UpdateStatusPayload } from '@codeswim/contract'

// VS Code-style update affordance: invisible until the main process has an
// update downloaded and ready, then a single button that restarts into the
// new version. Checking/downloading happen silently in main (updater.ts).
export function UpdateButton(): React.JSX.Element | null {
  const [ready, setReady] = useState<UpdateStatusPayload | null>(null)

  useEffect(() => {
    return window.api.onUpdateStatus((payload) => {
      setReady(payload.state === 'ready' ? payload : null)
    })
  }, [])

  if (!ready) return null

  return (
    <button
      className="update-chip"
      onClick={() => void window.api.installUpdate()}
      title={ready.version ? `Restart to update to v${ready.version}` : 'Restart to update'}
    >
      <span className="update-dot" />
      Restart to update
    </button>
  )
}
