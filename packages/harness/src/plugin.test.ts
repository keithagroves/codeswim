import { describe, expect, it } from 'vitest'
import { CodeswimPlugin, GATE_NOTE, VIEWING_META_KEY, viewingContext } from './plugin'

// The plugin factory doesn't read its input at construction time (it only wires
// up the session gate and returns hooks), so a bare cast is enough to reach the
// real hook handlers and exercise them directly.
async function loadHooks() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return CodeswimPlugin({} as any)
}

describe('viewingContext', () => {
  it('labels a markdown file as a diagram/doc', () => {
    const out = viewingContext('architecture/auth.md')
    expect(out).toContain('architecture/auth.md')
    expect(out).toContain('diagram/doc')
  })

  it('labels a non-markdown file as a source file', () => {
    const out = viewingContext('src/server.ts')
    expect(out).toContain('src/server.ts')
    expect(out).toContain('source file')
  })
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

describe('chat.message hook', () => {
  it('frames the part carrying the viewing metadata, leaving others alone', async () => {
    const hooks = await loadHooks()
    const userPart = { type: 'text', text: 'fix this' }
    const carrier = { type: 'text', text: '', metadata: { [VIEWING_META_KEY]: 'flows/login.md' } }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output = { parts: [userPart, carrier] } as any

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await hooks['chat.message']!({} as any, output)

    expect(userPart.text).toBe('fix this')
    expect(carrier.text).toBe(viewingContext('flows/login.md'))
  })

  it('ignores text parts without the metadata key', async () => {
    const hooks = await loadHooks()
    const plain = { type: 'text', text: 'hello', metadata: { other: 'x' } }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output = { parts: [plain] } as any

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await hooks['chat.message']!({} as any, output)

    expect(plain.text).toBe('hello')
  })
})
