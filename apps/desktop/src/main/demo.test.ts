import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import { demoSourceDir, ensureDemoWorkspace } from './demo'

describe('demoSourceDir', () => {
  it('reads from the monorepo examples dir in dev', () => {
    const dir = demoSourceDir(join(sep, 'repo', 'apps', 'desktop'), join(sep, 'ignored'), false)
    expect(dir).toBe(join(sep, 'repo', 'examples', 'sample-architecture'))
  })

  it('reads from the extraResources demo dir when packaged', () => {
    const dir = demoSourceDir(join(sep, 'app'), join(sep, 'Contents', 'Resources'), true)
    expect(dir).toBe(join(sep, 'Contents', 'Resources', 'demo'))
  })
})

describe('ensureDemoWorkspace', () => {
  let root: string
  let source: string
  let target: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'codeswim-demo-'))
    source = join(root, 'source')
    target = join(root, 'target')
    mkdirSync(join(source, 'src'), { recursive: true })
    writeFileSync(join(source, 'overview.md'), '# demo')
    writeFileSync(join(source, 'src', 'a.ts'), 'export {}')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('copies the demo recursively when the target does not exist', async () => {
    const result = await ensureDemoWorkspace(source, target)
    expect(result).toBe(target)
    expect(readFileSync(join(target, 'overview.md'), 'utf-8')).toBe('# demo')
    expect(existsSync(join(target, 'src', 'a.ts'))).toBe(true)
  })

  it('leaves an existing non-empty target untouched (user edits survive)', async () => {
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'overview.md'), '# edited by user')
    await ensureDemoWorkspace(source, target)
    expect(readFileSync(join(target, 'overview.md'), 'utf-8')).toBe('# edited by user')
    expect(existsSync(join(target, 'src'))).toBe(false)
  })

  it('populates an existing but empty target', async () => {
    mkdirSync(target, { recursive: true })
    await ensureDemoWorkspace(source, target)
    expect(existsSync(join(target, 'overview.md'))).toBe(true)
  })
})
