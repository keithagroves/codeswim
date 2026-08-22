// External-store-style registry of context blocks contributed by mounted
// surfaces (DiagramView, KanbanView, TerminalPanel, ...) via useSurfaceContext.
// One instance per StoreProvider (exposed as StoreApi.surfaceContext), for
// the provider's lifetime — this is how component-local state (a render
// error, an open dialog, a running terminal's active tab) becomes visible to
// the composed ScreenContextV2 publisher without hoisting it into the app
// reducer.
//
// getSnapshot()'s return identity only changes when a block's *value*
// actually changed (compared via JSON.stringify — these are small plain
// objects, not worth a real deep-equal dependency for), not on every upsert
// call, so useSyncExternalStore consumers don't re-render needlessly.
export type SurfaceContextListener = () => void

export class SurfaceContextRegistry {
  private blocks: Record<string, unknown> = {}
  private readonly listeners = new Set<SurfaceContextListener>()

  subscribe = (listener: SurfaceContextListener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): Record<string, unknown> => this.blocks

  upsert(name: string, block: unknown): void {
    if (JSON.stringify(this.blocks[name]) === JSON.stringify(block)) return
    this.blocks = { ...this.blocks, [name]: block }
    this.notify()
  }

  remove(name: string): void {
    if (!(name in this.blocks)) return
    const next = { ...this.blocks }
    delete next[name]
    this.blocks = next
    this.notify()
  }

  // Drops every block at once — called on workspace-root switch, since a
  // block keyed by e.g. a card id from the *previous* workspace is not just
  // stale but meaningless once the root changes.
  clear(): void {
    if (Object.keys(this.blocks).length === 0) return
    this.blocks = {}
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
