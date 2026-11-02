// Which model the whiteboard narrator speaks with, in the order to try them:
// the person's pick (the model menu under the board), then Unbiased's Pareto
// when it has a key, then the chat's model. The rest are fallbacks for when
// the one before is unavailable.
//
// opencode's free models are left out. They stream fast (measured
// 2026-10-29: 0.9-2 s to the first line), but the free tier refuses a request
// that offers the model no tools ("Free usage exceeded, subscribe to Go"),
// and the narrator's agents have every tool off.

import type { ConfiguredProvider, SelectedModel } from '../agent'

export const OPENCODE_PROVIDER = 'opencode'
export const PARETO_PROVIDER = 'pareto'

export function modelKey(m: SelectedModel): string {
  return `${m.providerID}/${m.modelID}`
}

/** Pareto answers in one burst (about 6 s for a part); other providers stream. */
export function streams(m: SelectedModel | undefined): boolean {
  return m !== undefined && m.providerID !== PARETO_PROVIDER
}

/** An opencode free-tier model: big-pickle, or any id ending in -free. */
export function isFree(m: SelectedModel): boolean {
  return (
    m.providerID === OPENCODE_PROVIDER &&
    (m.modelID === 'big-pickle' || m.modelID.endsWith('-free'))
  )
}

export function narratorCandidates(opts: {
  /** The person's pick; null means the default. */
  choice: SelectedModel | null
  /** What the narrator's opencode server can use right now. */
  providers: ConfiguredProvider[]
  /** The chat's model, the last resort. */
  chat?: SelectedModel
}): SelectedModel[] {
  const has = (m: SelectedModel): boolean =>
    opts.providers.some((p) => p.id === m.providerID && p.models.some((x) => x.id === m.modelID))
  const pareto = { providerID: PARETO_PROVIDER, modelID: PARETO_PROVIDER }
  const all = [
    // Before the server's list has loaded, trust the pick.
    ...(opts.choice && (has(opts.choice) || !opts.providers.length) ? [opts.choice] : []),
    ...(has(pareto) ? [pareto] : []),
    ...(opts.chat ? [opts.chat] : [])
  ]
  const seen = new Set<string>()
  return all.filter((m) => {
    const key = modelKey(m)
    if (seen.has(key) || isFree(m)) return false
    seen.add(key)
    return true
  })
}

/** An error that means "try another model", not "this question failed". */
export function isUnavailable(message: string): boolean {
  return /unavailable|not found|did you mean|no such model|not supported|usage exceeded|quota|api key|unauthorized|\b401\b|rate.?limit|too many requests|overloaded|\b429\b/i.test(
    message
  )
}
