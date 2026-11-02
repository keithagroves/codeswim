import { describe, expect, it } from 'vitest'
import type { ConfiguredProvider } from '../agent'
import { isFree, isUnavailable, modelKey, narratorCandidates, streams } from './narrator-models'

const provider = (id: string, ...models: string[]): ConfiguredProvider => ({
  id,
  name: id,
  models: models.map((m) => ({ id: m, name: m }))
})

const keys = (ms: { providerID: string; modelID: string }[]): string[] => ms.map(modelKey)

describe('narratorCandidates', () => {
  const providers = [
    provider('opencode', 'big-pickle', 'beam-free', 'zen-pro'),
    provider('pareto', 'pareto'),
    provider('anthropic', 'claude-sonnet')
  ]
  const chat = { providerID: 'anthropic', modelID: 'claude-sonnet' }

  it('defaults to Pareto, then the chat model', () => {
    expect(keys(narratorCandidates({ choice: null, providers, chat }))).toEqual([
      'pareto/pareto',
      'anthropic/claude-sonnet'
    ])
  })

  it('without a Pareto key, uses the chat model', () => {
    const noPareto = providers.filter((p) => p.id !== 'pareto')
    expect(keys(narratorCandidates({ choice: null, providers: noPareto, chat }))).toEqual([
      'anthropic/claude-sonnet'
    ])
  })

  it('puts the pick first, and keeps the defaults as fallbacks', () => {
    const pick = { providerID: 'opencode', modelID: 'zen-pro' }
    expect(keys(narratorCandidates({ choice: pick, providers, chat }))).toEqual([
      'opencode/zen-pro',
      'pareto/pareto',
      'anthropic/claude-sonnet'
    ])
  })

  it("skips a pick the server can't use, unless its list hasn't loaded yet", () => {
    const pick = { providerID: 'gone', modelID: 'model' }
    expect(keys(narratorCandidates({ choice: pick, providers }))).toEqual(['pareto/pareto'])
    expect(keys(narratorCandidates({ choice: pick, providers: [] }))).toEqual(['gone/model'])
  })

  it('never uses a free opencode model, which refuses tool-less requests', () => {
    const pick = { providerID: 'opencode', modelID: 'beam-free' }
    const chatFree = { providerID: 'opencode', modelID: 'big-pickle' }
    expect(keys(narratorCandidates({ choice: pick, providers, chat: chatFree }))).toEqual([
      'pareto/pareto'
    ])
    expect(isFree(pick)).toBe(true)
    expect(isFree({ providerID: 'opencode', modelID: 'zen-pro' })).toBe(false)
  })
})

describe('streams', () => {
  it('is false for Pareto, which answers in one burst', () => {
    expect(streams({ providerID: 'pareto', modelID: 'pareto' })).toBe(false)
    expect(streams({ providerID: 'anthropic', modelID: 'claude-sonnet' })).toBe(true)
    expect(streams(undefined)).toBe(false)
  })
})

describe('isUnavailable', () => {
  it('recognizes the errors that mean try another model', () => {
    expect(isUnavailable('Upstream request failed: Model is unavailable.')).toBe(true)
    expect(
      isUnavailable('Model not found: opencode/x. Did you mean: deepseek-v4.1-flash-free?')
    ).toBe(true)
    expect(isUnavailable('Rate limit exceeded')).toBe(true)
    expect(isUnavailable('Free usage exceeded, subscribe to Go')).toBe(true)
    expect(
      isUnavailable('Missing API key. Pass your key as "Authorization: Bearer <api-key>"')
    ).toBe(true)
    expect(isUnavailable('The request was aborted')).toBe(false)
  })
})
