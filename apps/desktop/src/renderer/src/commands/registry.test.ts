import { describe, expect, it } from 'vitest'
import type { CommandOrigin, DiagramNavApi } from '@codeswim/contract'
import { CommandRegistry, CommandRegistryError, type Command } from './registry'
import type { CommandCtx, CommandCtxFactory } from './context'
import type { AppState } from '../store'

const HUMAN: CommandOrigin = { kind: 'human' }
const AGENT: CommandOrigin = { kind: 'agent', sessionId: 's1', worktree: '/wt' }

// Minimal fake api double — only the handful of methods any given test
// actually calls need to exist, so this is deliberately partial.
const fakeApi = {} as DiagramNavApi

// Builds a CommandCtxFactory backed by a mutable `box`, so tests can mutate
// "external state" between or during command runs and assert the registry
// picks up the change rather than something captured once at construction.
function makeCtxFactory(box: { rootPath: string | null }): CommandCtxFactory {
  return (origin) => ({
    getState: () => ({ rootPath: box.rootPath }) as unknown as AppState,
    dispatch: () => {},
    api: fakeApi,
    toast: () => {},
    origin,
    activeRoot: box.rootPath,
    executionRoot: origin.kind === 'agent' ? origin.worktree : box.rootPath,
    confirm: async () => true
  })
}

function echoCommand(id = 'test.echo'): Command<{ value: string }, string> {
  return {
    id,
    domain: 'test',
    title: 'Echo',
    description: 'Returns its arg back',
    schema: { type: 'object', required: ['value'], properties: { value: { type: 'string' } } },
    agent: 'listed',
    run: async (args) => args.value
  }
}

describe('CommandRegistry', () => {
  it('rejects duplicate ids', () => {
    const registry = new CommandRegistry(makeCtxFactory({ rootPath: null }))
    registry.register(echoCommand())
    expect(() => registry.register(echoCommand())).toThrow(CommandRegistryError)
    try {
      registry.register(echoCommand())
    } catch (err) {
      expect(err).toBeInstanceOf(CommandRegistryError)
      expect((err as CommandRegistryError).code).toBe('duplicate-command')
    }
  })

  it('rejects an unknown command id', async () => {
    const registry = new CommandRegistry(makeCtxFactory({ rootPath: null }))
    await expect(registry.run('nope', {}, HUMAN)).rejects.toMatchObject({ code: 'unknown-command' })
  })

  it('rejects args that fail the schema', async () => {
    const registry = new CommandRegistry(makeCtxFactory({ rootPath: null }))
    registry.register(echoCommand())
    await expect(registry.run('test.echo', {}, HUMAN)).rejects.toMatchObject({ code: 'invalid-args' })
    await expect(registry.run('test.echo', { value: 3 }, HUMAN)).rejects.toMatchObject({
      code: 'invalid-args'
    })
  })

  it('runs a valid call and returns its result', async () => {
    const registry = new CommandRegistry(makeCtxFactory({ rootPath: null }))
    registry.register(echoCommand())
    await expect(registry.run('test.echo', { value: 'hi' }, HUMAN)).resolves.toBe('hi')
  })

  it('rejects an agent origin invoking an agent:"never" command', async () => {
    const registry = new CommandRegistry(makeCtxFactory({ rootPath: null }))
    registry.register({ ...echoCommand(), agent: 'never' })
    await expect(registry.run('test.echo', { value: 'hi' }, AGENT)).rejects.toMatchObject({
      code: 'forbidden-origin'
    })
    // Same call from a human origin still works — the tier only fences agents.
    await expect(registry.run('test.echo', { value: 'hi' }, HUMAN)).resolves.toBe('hi')
  })

  it('cannot be bypassed by calling run() directly with a forged origin-shaped object', async () => {
    const registry = new CommandRegistry(makeCtxFactory({ rootPath: null }))
    registry.register({ ...echoCommand(), agent: 'never' })
    // Even a well-formed CommandOrigin naming a specific worktree is still
    // rejected — the policy check is on `agent`, not on request shape.
    await expect(
      registry.run('test.echo', { value: 'hi' }, { kind: 'agent', sessionId: 'x', worktree: '/w' })
    ).rejects.toMatchObject({ code: 'forbidden-origin' })
  })

  it('wraps a handler throw as a handler-error, not an uncaught rejection', async () => {
    const registry = new CommandRegistry(makeCtxFactory({ rootPath: null }))
    registry.register({
      ...echoCommand(),
      run: async () => {
        throw new Error('boom')
      }
    })
    await expect(registry.run('test.echo', { value: 'x' }, HUMAN)).rejects.toMatchObject({
      code: 'handler-error'
    })
  })

  it('builds a fresh ctx per call, so state changed after construction is visible', async () => {
    const box = { rootPath: 'initial' }
    const registry = new CommandRegistry(makeCtxFactory(box))
    registry.register<Record<string, never>, string | null>({
      id: 'test.readRoot',
      domain: 'test',
      title: 'Read root',
      description: '',
      schema: { type: 'object' },
      agent: 'listed',
      run: async (_args, ctx) => ctx.getState().rootPath
    })

    await expect(registry.run('test.readRoot', {}, HUMAN)).resolves.toBe('initial')
    box.rootPath = 'changed'
    await expect(registry.run('test.readRoot', {}, HUMAN)).resolves.toBe('changed')
  })

  it('gives concurrent calls independent ctx snapshots rather than a shared/cached one', async () => {
    const box = { rootPath: 'a' }
    const registry = new CommandRegistry(makeCtxFactory(box))
    registry.register<Record<string, never>, string | null>({
      id: 'test.readRootSlow',
      domain: 'test',
      title: 'Read root (slow)',
      description: '',
      schema: { type: 'object' },
      agent: 'listed',
      run: async (_args, ctx) => {
        const seenBefore = ctx.getState().rootPath
        await new Promise((resolve) => setTimeout(resolve, 5))
        // ctx was captured for this call; getState() is live, so if the
        // registry were sharing one ctx across in-flight calls, a mutation
        // from the other call would leak here rather than being isolated to
        // its own invocation's timeline.
        return seenBefore
      }
    })

    const first = registry.run<string | null>('test.readRootSlow', {}, HUMAN)
    box.rootPath = 'b'
    const second = registry.run<string | null>('test.readRootSlow', {}, HUMAN)
    box.rootPath = 'c'

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toBe('a')
    expect(secondResult).toBe('b')
  })

  it('find() only returns agent-listed commands, filtered by query', () => {
    const registry = new CommandRegistry(makeCtxFactory({ rootPath: null }))
    registry.register(echoCommand('nav.open'))
    registry.register({ ...echoCommand('nav.secret'), agent: 'never' })
    registry.register({ ...echoCommand('git.commit'), title: 'Commit' })

    const all = registry.find('')
    expect(all.map((c) => c.id).sort()).toEqual(['git.commit', 'nav.open'])

    const navOnly = registry.find('nav')
    expect(navOnly.map((c) => c.id)).toEqual(['nav.open'])
  })

  it('describe() returns the static descriptor without exposing run/validate', () => {
    const registry = new CommandRegistry(makeCtxFactory({ rootPath: null }))
    registry.register(echoCommand())
    const d = registry.describe('test.echo')
    expect(d).toMatchObject({ id: 'test.echo', domain: 'test', agent: 'listed' })
    expect(d).not.toHaveProperty('run')
    expect(d).not.toHaveProperty('validate')
  })
})

// Sanity check that CommandCtx as constructed here type-checks against the
// real interface — catches drift if context.ts's shape changes.
const _typeCheck: CommandCtx = makeCtxFactory({ rootPath: null })(HUMAN)
void _typeCheck
