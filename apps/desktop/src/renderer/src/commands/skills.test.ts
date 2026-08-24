import { describe, expect, it, vi } from 'vitest'
import type { CommandOrigin, DiagramNavApi } from '@codeswim/contract'
import { CommandRegistry } from './registry'
import { registerSkillsCommands } from './skills'
import type { CommandCtxFactory } from './context'
import type { AppState } from '../store'

const HUMAN: CommandOrigin = { kind: 'human' }
const AGENT: CommandOrigin = { kind: 'agent', sessionId: 's1', worktree: '/wt/card-1' }

interface Harness {
  registry: CommandRegistry
  confirmCalls: string[]
  api: {
    listSkills: ReturnType<typeof vi.fn>
    listSkillFiles: ReturnType<typeof vi.fn>
    readSkillFile: ReturnType<typeof vi.fn>
    writeSkillFile: ReturnType<typeof vi.fn>
    agentsDocRead: ReturnType<typeof vi.fn>
    agentsDocWrite: ReturnType<typeof vi.fn>
    writeSkill: ReturnType<typeof vi.fn>
    deleteSkill: ReturnType<typeof vi.fn>
    linkSkillFolder: ReturnType<typeof vi.fn>
    openSkillInEditor: ReturnType<typeof vi.fn>
    agentsDocOpenInEditor: ReturnType<typeof vi.fn>
  }
}

function makeHarness(opts: { confirmResult?: boolean } = {}): Harness {
  const confirmCalls: string[] = []
  const api = {
    listSkills: vi.fn(async () => ({ builtin: [], global: [], workspace: [] })),
    listSkillFiles: vi.fn(async () => []),
    readSkillFile: vi.fn(async () => ({ binary: false, content: 'hi', size: 2 })),
    writeSkillFile: vi.fn(async () => {}),
    agentsDocRead: vi.fn(async () => ({ content: '', exists: false, size: 0 })),
    agentsDocWrite: vi.fn(async () => {}),
    writeSkill: vi.fn(async () => {}),
    deleteSkill: vi.fn(async () => {}),
    linkSkillFolder: vi.fn(async () => ({ linked: ['a'], skipped: [] })),
    openSkillInEditor: vi.fn(async () => {}),
    agentsDocOpenInEditor: vi.fn(async () => {})
  }

  const state: AppState = { rootPath: '/root' } as AppState

  const buildCtx: CommandCtxFactory = (origin) => ({
    getState: () => state,
    dispatch: () => {},
    api: api as unknown as DiagramNavApi,
    toast: () => {},
    origin,
    activeRoot: state.rootPath,
    executionRoot: origin.kind === 'agent' ? origin.worktree : state.rootPath,
    confirm: async (_danger, summary) => {
      confirmCalls.push(summary)
      return opts.confirmResult ?? true
    },
    startAgentInWorktree: async () => {},
    planSync: async () => {
      throw new Error('not used')
    },
    commitGroup: async () => {
      throw new Error('not used')
    }
  })

  const registry = new CommandRegistry(buildCtx)
  registerSkillsCommands(registry)

  return { registry, confirmCalls, api }
}

describe('read-only skills commands', () => {
  it('skills.list / skills.listFiles / skills.readFile / skills.readAgentsDoc are agent-reachable', async () => {
    const h = makeHarness()
    await expect(h.registry.run('skills.list', { root: '/root' }, AGENT)).resolves.toMatchObject({
      builtin: []
    })
    await expect(
      h.registry.run('skills.listFiles', { scope: 'workspace', name: 'foo', root: '/root' }, AGENT)
    ).resolves.toEqual([])
    await expect(
      h.registry.run(
        'skills.readFile',
        { scope: 'workspace', name: 'foo', path: 'SKILL.md', root: '/root' },
        AGENT
      )
    ).resolves.toMatchObject({ content: 'hi' })
    await expect(
      h.registry.run('skills.readAgentsDoc', { scope: 'workspace', root: '/root' }, AGENT)
    ).resolves.toMatchObject({ exists: false })
  })

  it('skills.list works with a null root (no workspace open)', async () => {
    const h = makeHarness()
    await h.registry.run('skills.list', { root: null }, HUMAN)
    expect(h.api.listSkills).toHaveBeenCalledWith(null)
  })
})

describe('mutating skills commands are never agent-reachable', () => {
  it.each([
    [
      'skills.writeFile',
      { scope: 'workspace', name: 'a', path: 'SKILL.md', content: 'x', root: '/root' }
    ],
    ['skills.writeAgentsDoc', { scope: 'workspace', content: 'x', root: '/root' }],
    ['skills.create', { scope: 'workspace', name: 'a', template: 'x', root: '/root' }],
    ['skills.delete', { scope: 'workspace', name: 'a', root: '/root' }],
    ['skills.linkFolder', { scope: 'workspace', source: '/src', root: '/root' }],
    ['skills.openInEditor', { scope: 'workspace', name: 'a', root: '/root' }],
    ['skills.openAgentsDocInEditor', { scope: 'workspace', root: '/root' }]
  ] as const)('%s rejects an agent origin', async (id, args) => {
    const h = makeHarness()
    await expect(h.registry.run(id, args, AGENT)).rejects.toMatchObject({
      code: 'forbidden-origin'
    })
  })
})

describe('skills.create', () => {
  it('rejects an invalid name before ever calling the API', async () => {
    const h = makeHarness()
    await expect(
      h.registry.run(
        'skills.create',
        { scope: 'workspace', name: 'bad/name', template: 'x', root: '/root' },
        HUMAN
      )
    ).rejects.toMatchObject({ code: 'invalid-args' })
    expect(h.api.writeSkill).not.toHaveBeenCalled()
  })

  it('rejects a workspace-scoped create with no root open', async () => {
    const h = makeHarness()
    await expect(
      h.registry.run(
        'skills.create',
        { scope: 'workspace', name: 'ok', template: 'x', root: null },
        HUMAN
      )
    ).rejects.toMatchObject({ code: 'invalid-args' })
  })

  it('creates a global skill with no root open', async () => {
    const h = makeHarness()
    await h.registry.run(
      'skills.create',
      { scope: 'global', name: 'ok', template: 'x', root: null },
      HUMAN
    )
    expect(h.api.writeSkill).toHaveBeenCalledWith('global', 'ok', 'x', null)
  })
})

describe('skills.delete', () => {
  it('is danger-gated and names the skill in the summary', async () => {
    const h = makeHarness()
    await h.registry.run(
      'skills.delete',
      { scope: 'workspace', name: 'my-skill', root: '/root' },
      HUMAN
    )
    expect(h.confirmCalls).toEqual(['Delete skill "my-skill"? This removes the entire folder.'])
    expect(h.api.deleteSkill).toHaveBeenCalledWith('workspace', 'my-skill', '/root')
  })

  it('summarizes a linked skill as an unlink, not a delete', async () => {
    const h = makeHarness()
    await h.registry.run(
      'skills.delete',
      { scope: 'workspace', name: 'my-skill', linkTarget: '/elsewhere/my-skill', root: '/root' },
      HUMAN
    )
    expect(h.confirmCalls).toEqual([
      'Unlink "my-skill" from this scope? The original at /elsewhere/my-skill won\'t be touched.'
    ])
  })

  it('a declined confirmation never calls deleteSkill', async () => {
    const h = makeHarness({ confirmResult: false })
    await expect(
      h.registry.run(
        'skills.delete',
        { scope: 'workspace', name: 'my-skill', root: '/root' },
        HUMAN
      )
    ).rejects.toMatchObject({ code: 'denied' })
    expect(h.api.deleteSkill).not.toHaveBeenCalled()
  })
})

describe('skills.linkFolder', () => {
  it('rejects linking into workspace scope with no root open', async () => {
    const h = makeHarness()
    await expect(
      h.registry.run('skills.linkFolder', { scope: 'workspace', source: '/src', root: null }, HUMAN)
    ).rejects.toMatchObject({ code: 'invalid-args' })
  })

  it('links into global scope with no root open', async () => {
    const h = makeHarness()
    const result = await h.registry.run(
      'skills.linkFolder',
      { scope: 'global', source: '/src', root: null },
      HUMAN
    )
    expect(result).toEqual({ linked: ['a'], skipped: [] })
  })
})
