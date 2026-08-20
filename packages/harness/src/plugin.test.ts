import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
const ctx = (worktree = '/wt', sessionID = 's1'): any => ({ worktree, sessionID })

const tmpDirs: string[] = []
const envKeys = ['CODESWIM_COMMAND_URL', 'CODESWIM_COMMAND_TOKEN'] as const

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
  for (const key of envKeys) delete process.env[key]
  vi.unstubAllGlobals()
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

function stubCommandBridge(): void {
  process.env.CODESWIM_COMMAND_URL = 'http://127.0.0.1:5173'
  process.env.CODESWIM_COMMAND_TOKEN = 'cap-token'
}

describe('when the command bridge is unavailable (no CODESWIM_COMMAND_* env)', () => {
  it('does not register open_file, find_command, or run_command', async () => {
    const hooks = await loadHooks()
    expect(hooks.tool!.open_file).toBeUndefined()
    expect(hooks.tool!.find_command).toBeUndefined()
    expect(hooks.tool!.run_command).toBeUndefined()
  })
})

describe('open_file tool', () => {
  it('calls nav.navigateAbsolute through the bridge and reports a real result', async () => {
    stubCommandBridge()
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://127.0.0.1:5173/run')
      expect(JSON.parse(init!.body as string)).toEqual({
        sessionId: 's1',
        worktree: '/wt',
        id: 'nav.navigateAbsolute',
        args: { relPath: 'flows/login.md', pushBreadcrumb: true }
      })
      return new Response(JSON.stringify({ ok: true, value: undefined }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const hooks = await loadHooks()
    const result = asOutput(await hooks.tool!.open_file.execute({ file: 'flows/login.md' }, ctx()))
    expect(result.output).toMatch(/Opened flows\/login\.md/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects a traversal path locally, without calling the bridge', async () => {
    stubCommandBridge()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const hooks = await loadHooks()
    const result = asOutput(await hooks.tool!.open_file.execute({ file: '../secret' }, ctx()))
    expect(result.output).toMatch(/error/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces a bridge-side rejection as an error, not a thrown exception', async () => {
    stubCommandBridge()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ ok: false, code: 'invalid-args', message: 'relPath: must be relative' }),
            { status: 200 }
          )
      )
    )

    const hooks = await loadHooks()
    const result = asOutput(await hooks.tool!.open_file.execute({ file: 'ok.md' }, ctx()))
    expect(result.output).toMatch(/error: relPath: must be relative/)
  })
})

describe('find_command tool', () => {
  it('forwards the query and formats the matched commands', async () => {
    stubCommandBridge()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).toBe('http://127.0.0.1:5173/find')
        return new Response(
          JSON.stringify({
            commands: [
              { id: 'nav.setWorkspaceView', domain: 'nav', title: 'x', description: 'Switch tab', schema: {}, agent: 'listed' }
            ]
          }),
          { status: 200 }
        )
      })
    )

    const hooks = await loadHooks()
    const result = asOutput(await hooks.tool!.find_command.execute({ query: 'view' }, ctx()))
    expect(result.output).toContain('nav.setWorkspaceView: Switch tab')
  })
})

describe('run_command tool', () => {
  it('forwards id/args and reports the bridge result', async () => {
    stubCommandBridge()
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(init!.body as string)).toMatchObject({
        id: 'nav.setWorkspaceView',
        args: { view: 'kanban' }
      })
      return new Response(JSON.stringify({ ok: true, value: undefined }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const hooks = await loadHooks()
    const result = asOutput(
      await hooks.tool!.run_command.execute({ id: 'nav.setWorkspaceView', args: { view: 'kanban' } }, ctx())
    )
    expect(result.output).toMatch(/Ran nav\.setWorkspaceView/)
  })

  it('a command an agent origin is forbidden from still comes back as an error, not a thrown exception', async () => {
    stubCommandBridge()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ ok: false, code: 'forbidden-origin', message: 'command not available to agents: nav.goBack' }),
            { status: 200 }
          )
      )
    )

    const hooks = await loadHooks()
    const result = asOutput(await hooks.tool!.run_command.execute({ id: 'nav.goBack' }, ctx()))
    expect(result.output).toMatch(/error: command not available to agents/)
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
