import { describe, expect, it, vi } from 'vitest'
import { SurfaceContextRegistry } from './surface-context'

describe('SurfaceContextRegistry', () => {
  it('starts empty', () => {
    const registry = new SurfaceContextRegistry()
    expect(registry.getSnapshot()).toEqual({})
  })

  it('upsert adds a block and notifies subscribers', () => {
    const registry = new SurfaceContextRegistry()
    const listener = vi.fn()
    registry.subscribe(listener)
    registry.upsert('a', { x: 1 })
    expect(registry.getSnapshot()).toEqual({ a: { x: 1 } })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('upsert with an unchanged value does not notify or change snapshot identity', () => {
    const registry = new SurfaceContextRegistry()
    registry.upsert('a', { x: 1 })
    const before = registry.getSnapshot()
    const listener = vi.fn()
    registry.subscribe(listener)
    registry.upsert('a', { x: 1 })
    expect(registry.getSnapshot()).toBe(before)
    expect(listener).not.toHaveBeenCalled()
  })

  it('upsert with a changed value notifies and changes snapshot identity', () => {
    const registry = new SurfaceContextRegistry()
    registry.upsert('a', { x: 1 })
    const before = registry.getSnapshot()
    registry.upsert('a', { x: 2 })
    expect(registry.getSnapshot()).not.toBe(before)
    expect(registry.getSnapshot()).toEqual({ a: { x: 2 } })
  })

  it('remove drops a block and notifies', () => {
    const registry = new SurfaceContextRegistry()
    registry.upsert('a', { x: 1 })
    const listener = vi.fn()
    registry.subscribe(listener)
    registry.remove('a')
    expect(registry.getSnapshot()).toEqual({})
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('remove of a name that was never present is a no-op', () => {
    const registry = new SurfaceContextRegistry()
    const listener = vi.fn()
    registry.subscribe(listener)
    registry.remove('nope')
    expect(listener).not.toHaveBeenCalled()
  })

  it('clear drops every block at once and notifies once', () => {
    const registry = new SurfaceContextRegistry()
    registry.upsert('a', { x: 1 })
    registry.upsert('b', { y: 2 })
    const listener = vi.fn()
    registry.subscribe(listener)
    registry.clear()
    expect(registry.getSnapshot()).toEqual({})
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('clear on an already-empty registry does not notify', () => {
    const registry = new SurfaceContextRegistry()
    const listener = vi.fn()
    registry.subscribe(listener)
    registry.clear()
    expect(listener).not.toHaveBeenCalled()
  })

  it('unsubscribe stops further notifications', () => {
    const registry = new SurfaceContextRegistry()
    const listener = vi.fn()
    const unsubscribe = registry.subscribe(listener)
    unsubscribe()
    registry.upsert('a', { x: 1 })
    expect(listener).not.toHaveBeenCalled()
  })

  it('keeps independent blocks under different names', () => {
    const registry = new SurfaceContextRegistry()
    registry.upsert('a', { x: 1 })
    registry.upsert('b', { y: 2 })
    expect(registry.getSnapshot()).toEqual({ a: { x: 1 }, b: { y: 2 } })
    registry.remove('a')
    expect(registry.getSnapshot()).toEqual({ b: { y: 2 } })
  })
})
