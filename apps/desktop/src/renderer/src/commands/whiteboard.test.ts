import { describe, expect, it, vi } from 'vitest'
import type { CommandOrigin, DiagramNavApi } from '@codeswim/contract'
import { CommandRegistry, CommandRegistryError } from './registry'
import { registerWhiteboardCommands, type WhiteboardCommandTarget } from './whiteboard'
import type { CommandCtxFactory } from './context'
import type { AppState } from '../store'

const HUMAN: CommandOrigin = { kind: 'human' }
const AGENT: CommandOrigin = { kind: 'agent', sessionId: 's1', worktree: '/root' }

interface Harness {
  registry: CommandRegistry
  target: WhiteboardCommandTarget
  dispatched: unknown[]
}

function makeHarness(): Harness {
  const dispatched: unknown[] = []
  const target: WhiteboardCommandTarget = {
    ask: vi.fn(async () => {}),
    interrupt: vi.fn(),
    openLink: vi.fn(async () => {})
  }
  const buildCtx: CommandCtxFactory = (origin) => ({
    getState: () => ({ rootPath: '/root' }) as AppState,
    dispatch: (action) => dispatched.push(action),
    api: {} as DiagramNavApi,
    toast: () => {},
    origin,
    activeRoot: '/root',
    executionRoot: '/root',
    confirm: async () => true,
    startAgentInWorktree: async () => {},
    planSync: async () => {
      throw new Error('unused')
    },
    commitGroup: async () => {
      throw new Error('unused')
    }
  })
  const registry = new CommandRegistry(buildCtx)
  registerWhiteboardCommands(registry, () => target)
  return { registry, target, dispatched }
}

describe('whiteboard commands', () => {
  it('whiteboard.ask switches to the whiteboard and asks', async () => {
    const { registry, target, dispatched } = makeHarness()
    await registry.run('whiteboard.ask', { text: 'How should auth work?' }, HUMAN)
    expect(dispatched).toEqual([{ type: 'set-workspace-view', view: 'whiteboard' }])
    expect(target.ask).toHaveBeenCalledWith('How should auth work?')
  })

  it("whiteboard.ask is human-only, so an agent can't say yes to a build", async () => {
    const { registry, target } = makeHarness()
    await expect(
      registry.run('whiteboard.ask', { text: 'yes, build it' }, AGENT)
    ).rejects.toMatchObject({
      code: 'forbidden-origin'
    })
    expect(target.ask).not.toHaveBeenCalled()
    expect(registry.find('whiteboard').map((c) => c.id)).not.toContain('whiteboard.ask')
  })

  it('rejects an empty question', async () => {
    const { registry } = makeHarness()
    await expect(registry.run('whiteboard.ask', { text: '  ' }, HUMAN)).rejects.toBeInstanceOf(
      CommandRegistryError
    )
  })

  it('whiteboard.stop interrupts, for agents too', async () => {
    const { registry, target } = makeHarness()
    await registry.run('whiteboard.stop', {}, AGENT)
    expect(target.interrupt).toHaveBeenCalled()
  })

  it('whiteboard.openLink opens workspace paths only', async () => {
    const { registry, target } = makeHarness()
    await registry.run('whiteboard.openLink', { path: 'architecture/auth.md' }, AGENT)
    expect(target.openLink).toHaveBeenCalledWith('architecture/auth.md')
    await expect(
      registry.run('whiteboard.openLink', { path: '../secrets.md' }, HUMAN)
    ).rejects.toMatchObject({
      code: 'invalid-args'
    })
    await expect(
      registry.run('whiteboard.openLink', { path: '/etc/passwd' }, HUMAN)
    ).rejects.toMatchObject({
      code: 'invalid-args'
    })
  })
})
