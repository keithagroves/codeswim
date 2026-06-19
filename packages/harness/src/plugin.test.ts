import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CodeswimPlugin, GATE_NOTE } from './plugin'

// The plugin factory doesn't read its input at construction time (it only wires
// up the session gate and returns hooks), so a bare cast is enough to reach the
// real hook handlers and tools and exercise them directly.
async function loadHooks() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return CodeswimPlugin({} as any)
}

// execute() is typed as `ToolResult` (a string | object union); the codeswim
// tools always return the object form, so narrow it for assertions.
interface ToolOutput {
  output?: string
  metadata?: unknown
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asOutput = (r: any): ToolOutput => r as ToolOutput
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = (worktree?: string): any => ({ worktree })

const tmpDirs: string[] = []
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('tool.definition hook', () => {
  it('appends the gate note to code-mutating tools', async () => {
    const hooks = await loadHooks()
    for (const toolID of ['write', 'edit', 'apply_patch']) {
      const output = { description: 'base description', parameters: {} }
      await hooks['tool.definition']!({ toolID }, output)
      expect(output.description).toBe('base description' + GATE_NOTE)
    }
  })

  it('leaves other tools untouched', async () => {
    const hooks = await loadHooks()
    const output = { description: 'read a file', parameters: {} }
    await hooks['tool.definition']!({ toolID: 'read' }, output)
    expect(output.description).toBe('read a file')
  })
})

describe('open_file tool', () => {
  it('emits an open_file action for a valid path', async () => {
    const hooks = await loadHooks()
    const result = asOutput(await hooks.tool!.open_file.execute({ file: 'flows/login.md' }, ctx()))
    expect(result.metadata).toEqual({
      codeswim_action: { type: 'open_file', path: 'flows/login.md' }
    })
  })

  it('rejects a traversal path without emitting an action', async () => {
    const hooks = await loadHooks()
    const result = asOutput(await hooks.tool!.open_file.execute({ file: '../secret' }, ctx()))
    expect(result.output).toMatch(/error/)
    expect(result.metadata).toBeUndefined()
  })
})

describe('set_view tool', () => {
  it('emits a set_view action', async () => {
    const hooks = await loadHooks()
    const result = asOutput(await hooks.tool!.set_view.execute({ view: 'kanban' }, ctx()))
    expect(result.metadata).toEqual({ codeswim_action: { type: 'set_view', view: 'kanban' } })
  })
})

describe('get_app_state tool', () => {
  it('reads and formats the published snapshot', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'codeswim-state-'))
    tmpDirs.push(dir)
    await mkdir(path.join(dir, '.codeswim'), { recursive: true })
    await writeFile(
      path.join(dir, '.codeswim', 'agent-state.json'),
      JSON.stringify({
        workspaceView: 'navigator',
        currentFile: 'overview.md',
        currentDocumentPath: 'overview.md',
        view: 'diagram',
        breadcrumbs: [],
        runningScript: null
      })
    )
    const hooks = await loadHooks()
    const result = asOutput(await hooks.tool!.get_app_state.execute({}, ctx(dir)))
    expect(result.output).toContain('overview.md')
    expect(result.output).toContain('diagram navigator')
  })

  it('degrades gracefully when no snapshot exists', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'codeswim-state-'))
    tmpDirs.push(dir)
    const hooks = await loadHooks()
    const result = asOutput(await hooks.tool!.get_app_state.execute({}, ctx(dir)))
    expect(result.output).toMatch(/No app state/)
  })
})
