// Animation timing. Progress comes from the wall clock, so a throttled window
// still finishes on time.

/**
 * Next animation step: an animation frame, or a timer if the window is hidden
 * (requestAnimationFrame pauses then).
 */
export const frame = (): Promise<void> =>
  new Promise<void>((r) => {
    let done = false
    const go = (): void => {
      if (!done) {
        done = true
        r()
      }
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(go)
    setTimeout(go, 40)
  })

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Ease in and out (quadratic). */
export const ease = (p: number): number => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2)

/** Call fn with progress 0..1 over ms, once per frame, ending on exactly 1. */
export async function animate(ms: number, fn: (p: number) => void): Promise<void> {
  const start = performance.now()
  for (;;) {
    const p = Math.min(1, (performance.now() - start) / Math.max(1, ms))
    fn(p)
    if (p >= 1) return
    await frame()
  }
}
