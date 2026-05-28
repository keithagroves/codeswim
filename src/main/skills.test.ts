// Tests for the skills module. Every test runs against a fresh temp
// workspace under os.tmpdir() so we never touch the user's real
// ~/.agents/skills directory. We deliberately exercise workspace-scope
// operations only — global-scope reads/writes would otherwise leak into
// the developer's home.
//
// `electron` is mocked because the production module imports `app` for the
// built-in prompt path resolution; tests cover the workspace + symlink
// behavior, so the mock just needs to be importable.

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd()
  }
}))

// Import after the mock so the module picks up the stub.
const skills = await import('./skills')

let workspace: string
let externalSource: string

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'codeswim-skills-ws-'))
  externalSource = await fs.mkdtemp(path.join(os.tmpdir(), 'codeswim-skills-ext-'))
})

afterEach(async () => {
  await Promise.allSettled([
    fs.rm(workspace, { recursive: true, force: true }),
    fs.rm(externalSource, { recursive: true, force: true })
  ])
})

async function writeSkillMd(
  root: string,
  _scope: 'workspace',
  name: string,
  content: string
): Promise<string> {
  const dir = path.join(root, '.agents', 'skills', name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'SKILL.md'), content, 'utf-8')
  return dir
}

const sampleSkill = (name: string, description = 'Sample skill body'): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody.`

describe('listSkills (workspace)', () => {
  it('returns an empty workspace list when no skills exist', async () => {
    const result = await skills.listSkills(workspace)
    expect(result.workspace).toEqual([])
  })

  it('finds workspace skills with SKILL.md and extracts their descriptions', async () => {
    await writeSkillMd(workspace, 'workspace', 'alpha', sampleSkill('alpha', 'Alpha skill'))
    await writeSkillMd(workspace, 'workspace', 'beta', sampleSkill('beta', 'Beta skill'))
    const result = await skills.listSkills(workspace)
    expect(result.workspace.map((s) => s.name)).toEqual(['alpha', 'beta'])
    expect(result.workspace[0].description).toBe('Alpha skill')
    expect(result.workspace[0].scope).toBe('workspace')
    expect(result.workspace[0].readOnly).toBe(false)
  })

  it('handles block-scalar descriptions (description: |)', async () => {
    const yaml = '---\nname: gamma\ndescription: |\n  Line one\n  line two\n---\n'
    await writeSkillMd(workspace, 'workspace', 'gamma', yaml)
    const result = await skills.listSkills(workspace)
    expect(result.workspace[0].description).toBe('Line one line two')
  })

  it('skips directories without a SKILL.md', async () => {
    await fs.mkdir(path.join(workspace, '.agents', 'skills', 'not-a-skill'), { recursive: true })
    const result = await skills.listSkills(workspace)
    expect(result.workspace).toEqual([])
  })

  it('rejects directories with unsafe names', async () => {
    // Names starting with `.` or containing path separators are skipped.
    // We can't even create one with `/` in it inside the skills dir, but
    // a hidden `.cache` should be filtered.
    const dir = path.join(workspace, '.agents', 'skills', '.cache')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'SKILL.md'), sampleSkill('cache'), 'utf-8')
    const result = await skills.listSkills(workspace)
    expect(result.workspace).toEqual([])
  })

  it('flags symlinked skill directories with a linkTarget', async () => {
    const external = path.join(externalSource, 'linked-skill')
    await fs.mkdir(external, { recursive: true })
    await fs.writeFile(path.join(external, 'SKILL.md'), sampleSkill('linked-skill'), 'utf-8')
    const skillsDir = path.join(workspace, '.agents', 'skills')
    await fs.mkdir(skillsDir, { recursive: true })
    await fs.symlink(external, path.join(skillsDir, 'linked-skill'), 'dir')

    const result = await skills.listSkills(workspace)
    expect(result.workspace).toHaveLength(1)
    expect(result.workspace[0].linkTarget).toBe(await fs.realpath(external))
  })

  it('passing null rootPath returns no workspace skills', async () => {
    const result = await skills.listSkills(null)
    expect(result.workspace).toEqual([])
  })
})

describe('listSkillFiles', () => {
  it('returns SKILL.md plus nested files for a workspace skill', async () => {
    const skillRoot = await writeSkillMd(workspace, 'workspace', 'firecrawl', sampleSkill('firecrawl'))
    await fs.mkdir(path.join(skillRoot, 'rules'), { recursive: true })
    await fs.writeFile(path.join(skillRoot, 'rules', 'install.md'), '# install', 'utf-8')
    await fs.writeFile(path.join(skillRoot, 'rules', 'security.md'), '# security', 'utf-8')

    const tree = await skills.listSkillFiles('workspace', 'firecrawl', workspace)
    // Directories before files, alpha-sorted within.
    expect(tree).toEqual([
      {
        kind: 'dir',
        name: 'rules',
        path: 'rules',
        children: [
          { kind: 'file', name: 'install.md', path: 'rules/install.md' },
          { kind: 'file', name: 'security.md', path: 'rules/security.md' }
        ]
      },
      { kind: 'file', name: 'SKILL.md', path: 'SKILL.md' }
    ])
  })

  it('ignores .DS_Store and similar noise files', async () => {
    const skillRoot = await writeSkillMd(workspace, 'workspace', 'tidy', sampleSkill('tidy'))
    await fs.writeFile(path.join(skillRoot, '.DS_Store'), '', 'utf-8')
    const tree = await skills.listSkillFiles('workspace', 'tidy', workspace)
    expect(tree.map((n) => n.name)).toEqual(['SKILL.md'])
  })

  it('rejects unsafe skill names', async () => {
    await expect(
      skills.listSkillFiles('workspace', '../etc/passwd', workspace)
    ).rejects.toThrow(/invalid skill name/)
  })
})

describe('readSkillFile', () => {
  it('reads a text file and reports non-binary', async () => {
    await writeSkillMd(workspace, 'workspace', 'alpha', sampleSkill('alpha', 'Hello'))
    const result = await skills.readSkillFile('workspace', 'alpha', 'SKILL.md', workspace)
    expect(result.binary).toBe(false)
    expect(result.content).toContain('# alpha')
    expect(result.size).toBeGreaterThan(0)
  })

  it('reports binary for files with a NUL byte in the first chunk', async () => {
    const skillRoot = await writeSkillMd(workspace, 'workspace', 'bin', sampleSkill('bin'))
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03])
    await fs.writeFile(path.join(skillRoot, 'tiny.png'), buf)
    const result = await skills.readSkillFile('workspace', 'bin', 'tiny.png', workspace)
    expect(result.binary).toBe(true)
    expect(result.content).toBe('')
  })

  it('rejects paths that try to escape the skill dir', async () => {
    await writeSkillMd(workspace, 'workspace', 'alpha', sampleSkill('alpha'))
    await expect(
      skills.readSkillFile('workspace', 'alpha', '../alpha/SKILL.md', workspace)
    ).rejects.toThrow(/invalid path inside skill/)
  })

  it('rejects absolute paths', async () => {
    await writeSkillMd(workspace, 'workspace', 'alpha', sampleSkill('alpha'))
    await expect(
      skills.readSkillFile('workspace', 'alpha', '/etc/passwd', workspace)
    ).rejects.toThrow(/invalid path inside skill/)
  })
})

describe('writeSkillFile', () => {
  it('writes nested files inside an existing skill', async () => {
    await writeSkillMd(workspace, 'workspace', 'alpha', sampleSkill('alpha'))
    await skills.writeSkillFile(
      'workspace',
      'alpha',
      'rules/new.md',
      '# new',
      workspace
    )
    const onDisk = await fs.readFile(
      path.join(workspace, '.agents', 'skills', 'alpha', 'rules', 'new.md'),
      'utf-8'
    )
    expect(onDisk).toBe('# new')
  })

  it('refuses to write built-in skills', async () => {
    await expect(
      skills.writeSkillFile('builtin', 'system', 'SKILL.md', 'hi', null)
    ).rejects.toThrow(/built-in.*read-only/)
  })

  it('refuses to escape the skill dir', async () => {
    await writeSkillMd(workspace, 'workspace', 'alpha', sampleSkill('alpha'))
    await expect(
      skills.writeSkillFile('workspace', 'alpha', '../alpha-evil/SKILL.md', 'hi', workspace)
    ).rejects.toThrow(/invalid path inside skill/)
  })
})

describe('deleteSkill', () => {
  it('removes a real skill directory recursively', async () => {
    const skillRoot = await writeSkillMd(workspace, 'workspace', 'doomed', sampleSkill('doomed'))
    await fs.mkdir(path.join(skillRoot, 'rules'), { recursive: true })
    await fs.writeFile(path.join(skillRoot, 'rules', 'a.md'), 'a', 'utf-8')

    await skills.deleteSkill('workspace', 'doomed', workspace)
    await expect(fs.access(skillRoot)).rejects.toBeDefined()
  })

  it('unlinks a symlinked skill without touching the target', async () => {
    const external = path.join(externalSource, 'linked-skill')
    await fs.mkdir(external, { recursive: true })
    await fs.writeFile(path.join(external, 'SKILL.md'), sampleSkill('linked-skill'), 'utf-8')
    const linkAt = path.join(workspace, '.agents', 'skills', 'linked-skill')
    await fs.mkdir(path.dirname(linkAt), { recursive: true })
    await fs.symlink(external, linkAt, 'dir')

    await skills.deleteSkill('workspace', 'linked-skill', workspace)

    await expect(fs.lstat(linkAt)).rejects.toBeDefined()
    // The original must still exist with its SKILL.md intact.
    const original = await fs.readFile(path.join(external, 'SKILL.md'), 'utf-8')
    expect(original).toContain('linked-skill')
  })

  it('refuses to delete a built-in', async () => {
    await expect(skills.deleteSkill('builtin', 'system', null)).rejects.toThrow(
      /built-in.*read-only/
    )
  })
})

describe('linkFolder', () => {
  it('symlinks each child SKILL.md tree found in the source', async () => {
    await fs.mkdir(path.join(externalSource, 'alpha'), { recursive: true })
    await fs.writeFile(
      path.join(externalSource, 'alpha', 'SKILL.md'),
      sampleSkill('alpha'),
      'utf-8'
    )
    await fs.mkdir(path.join(externalSource, 'beta'), { recursive: true })
    await fs.writeFile(
      path.join(externalSource, 'beta', 'SKILL.md'),
      sampleSkill('beta'),
      'utf-8'
    )

    const result = await skills.linkFolder('workspace', externalSource, workspace)
    expect(result.linked.sort()).toEqual(['alpha', 'beta'])
    expect(result.skipped).toEqual([])

    // Confirm both are real symlinks on disk.
    const skillsDir = path.join(workspace, '.agents', 'skills')
    for (const name of ['alpha', 'beta']) {
      const stat = await fs.lstat(path.join(skillsDir, name))
      expect(stat.isSymbolicLink()).toBe(true)
    }
  })

  it('skips directories without a SKILL.md', async () => {
    await fs.mkdir(path.join(externalSource, 'not-a-skill'), { recursive: true })
    const result = await skills.linkFolder('workspace', externalSource, workspace)
    expect(result.linked).toEqual([])
    expect(result.skipped).toEqual([{ name: 'not-a-skill', reason: 'no SKILL.md' }])
  })

  it('skips entries that would collide with existing skills', async () => {
    // Pre-create a real workspace skill named `firecrawl`.
    await writeSkillMd(workspace, 'workspace', 'firecrawl', sampleSkill('firecrawl'))
    // Now try to link an external one with the same name.
    await fs.mkdir(path.join(externalSource, 'firecrawl'), { recursive: true })
    await fs.writeFile(
      path.join(externalSource, 'firecrawl', 'SKILL.md'),
      sampleSkill('firecrawl', 'external'),
      'utf-8'
    )
    const result = await skills.linkFolder('workspace', externalSource, workspace)
    expect(result.linked).toEqual([])
    expect(result.skipped).toEqual([{ name: 'firecrawl', reason: 'already exists' }])

    // And the original real skill is untouched.
    const onDisk = await fs.readFile(
      path.join(workspace, '.agents', 'skills', 'firecrawl', 'SKILL.md'),
      'utf-8'
    )
    expect(onDisk).toContain('firecrawl')
    expect(onDisk).not.toContain('external')
  })

  it('refuses workspace links when rootPath is null', async () => {
    await expect(
      skills.linkFolder('workspace', externalSource, null)
    ).rejects.toThrow(/no workspace open/)
  })
})
