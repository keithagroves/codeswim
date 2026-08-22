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
//
// `confirm` mirrors the real adapter in state.tsx exactly: agent origins are
// denied unconditionally, human origins go through `opts.humanConfirms` (the
// stand-in for the human confirmation adapter). `opts.onConfirm` lets a test
// assert confirm was (or wasn't) reached at all.
function makeCtxFactory(
  box: { rootPath: string | null },
  opts: { humanConfirms?: boolean; onConfirm?: (summary: string) => void } = {}
): CommandCtxFactory {
  return (origin) => ({
    getState: () => ({ rootPath: box.rootPath }) as unknown as AppState,
    dispatch: () => {},
    api: fakeApi,
    toast: () => {},
    origin,
    activeRoot: box.rootPath,
    executionRoot: origin.kind === 'agent' ? origin.worktree : box.rootPath,
    confirm: async (_danger, summary) => {
      opts.onConfirm?.(summary)
      if (origin.kind === 'agent') return false
      return opts.humanConfirms ?? true
    },
    startAgentInWorktree: async () => {},
    planSync: async () => {
      throw new Error('not used by registry tests')
    },
    commitGroup: async () => {
      throw new Error('not used by registry tests')
    }
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

// agent: 'listed' deliberately — the danger gate must hold even for a tier
// that would otherwise let an agent reach this command, since the two gates
// (agent tier, danger confirmation) are independent.
function dangerCommand(id = 'test.danger'): Command<{ value: string }, string> {
  return {
    ...echoCommand(id),
    danger: {
      kind: 'destructive',
      summarize: (args) => `About to act on "${args.value}"`
    },
    run: async (args) => `did:${args.value}`
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
    await expect(registry.run('test.echo', {}, HUMAN)).rejects.toMatchObject({
      code: 'invalid-args'
    })
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

// Phase 4 (plans/command-bus-and-screen-context.md): the fail-closed
// approval seam. ctx.confirm is the injection point (see state.tsx's real
// adapter) — these tests exercise the registry's side of the contract using
// the same human/agent split the real adapter implements.
describe('CommandRegistry: danger commands', () => {
  it('runs the handler once a human origin confirms', async () => {
    const registry = new CommandRegistry(
      makeCtxFactory({ rootPath: null }, { humanConfirms: true })
    )
    registry.register(dangerCommand())
    await expect(registry.run('test.danger', { value: 'x' }, HUMAN)).resolves.toBe('did:x')
  })

  it('a cancelled human confirmation is a real typed result, not a thrown handler error, and the handler never runs', async () => {
    const registry = new CommandRegistry(
      makeCtxFactory({ rootPath: null }, { humanConfirms: false })
    )
    let ran = false
    registry.register({
      ...dangerCommand(),
      run: async (args) => {
        ran = true
        return `did:${args.value}`
      }
    })
    await expect(registry.run('test.danger', { value: 'x' }, HUMAN)).rejects.toMatchObject({
      code: 'denied'
    })
    expect(ran).toBe(false)
  })

  it('an agent origin is denied without ever running the handler, even though the command is agent: "listed"', async () => {
    const registry = new CommandRegistry(
      makeCtxFactory({ rootPath: null }, { humanConfirms: true })
    )
    let ran = false
    registry.register({
      ...dangerCommand(),
      run: async (args) => {
        ran = true
        return `did:${args.value}`
      }
    })
    await expect(registry.run('test.danger', { value: 'x' }, AGENT)).rejects.toMatchObject({
      code: 'denied'
    })
    expect(ran).toBe(false)
  })

  it('cannot be bypassed by a forged agent origin naming an arbitrary worktree', async () => {
    const registry = new CommandRegistry(
      makeCtxFactory({ rootPath: null }, { humanConfirms: true })
    )
    registry.register(dangerCommand())
    await expect(
      registry.run(
        'test.danger',
        { value: 'x' },
        { kind: 'agent', sessionId: 'forged', worktree: '/anywhere' }
      )
    ).rejects.toMatchObject({ code: 'denied' })
  })

  it('derives the danger summary only after validation, so invalid args never reach it', async () => {
    const registry = new CommandRegistry(
      makeCtxFactory({ rootPath: null }, { humanConfirms: true })
    )
    registry.register<{ value: string }, string>({
      ...dangerCommand(),
      validate: (args) => {
        if (args.value === 'bad') throw new Error('value must not be "bad"')
      },
      danger: {
        kind: 'destructive',
        summarize: (args) => {
          // If this ever ran on invalid args, it would itself throw —
          // proving the ordering by making a violation loud, not silent.
          if (args.value === 'bad') throw new Error('summarize must not see invalid args')
          return `About to act on "${args.value}"`
        }
      }
    })
    await expect(registry.run('test.danger', { value: 'bad' }, HUMAN)).rejects.toMatchObject({
      code: 'invalid-args'
    })
  })

  it('passes the derived summary to confirm', async () => {
    const summaries: string[] = []
    const registry = new CommandRegistry(
      makeCtxFactory(
        { rootPath: null },
        { humanConfirms: true, onConfirm: (s) => summaries.push(s) }
      )
    )
    registry.register(dangerCommand())
    await registry.run('test.danger', { value: 'the-thing' }, HUMAN)
    expect(summaries).toEqual(['About to act on "the-thing"'])
  })
})

// Sanity check that CommandCtx as constructed here type-checks against the
// real interface — catches drift if context.ts's shape changes.
const _typeCheck: CommandCtx = makeCtxFactory({ rootPath: null })(HUMAN)
void _typeCheck
