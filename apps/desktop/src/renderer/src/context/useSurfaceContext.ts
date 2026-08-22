import { useEffect } from 'react'
import { useStore } from '../store'

// Publishes `block` under `name` in the shared surface-context registry
// (StoreApi.surfaceContext) for as long as the calling component is
// mounted. Pass `null` to withdraw the block without unmounting (e.g. "no
// render error right now") — the registry key is removed either way when
// the component unmounts.
export function useSurfaceContext<T>(name: string, block: T | null): void {
  const { surfaceContext } = useStore()

  useEffect(() => {
    if (block === null) {
      surfaceContext.remove(name)
      return
    }
    surfaceContext.upsert(name, block)
    // Deliberately no cleanup here — this effect's job is to keep the
    // registry in sync with the latest `block` on every change, not to
    // remove it when `block` changes. Final removal is the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surfaceContext, name, block])

  useEffect(() => {
    return () => surfaceContext.remove(name)
  }, [surfaceContext, name])
}
