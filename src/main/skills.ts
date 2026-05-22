// Skill files are user-authored markdown prompts that the agent can pick
// up. Two scopes:
//   - global:    ~/.agents/skills/<name>/SKILL.md   (shared across workspaces)
//   - workspace: <root>/.agents/skills/<name>/SKILL.md
// Plus a read-only "builtin" scope that exposes the prompts codeswim ships
// (system.txt, mdd-fixes.md) so users can see what the agent is told by
// default.
//
// Each skill is a directory containing a SKILL.md file. Frontmatter on
// SKILL.md typically has `name`, `description`, and optionally
// `allowed-tools`. We treat the directory name as the canonical skill
// name; the SKILL.md frontmatter description shows up in the list.

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type SkillScope = 'global' | 'workspace' | 'builtin'

export interface SkillSummary {
  scope: SkillScope
  name: string
  description: string
  readOnly: boolean
  // If the skill directory is a symlink, the resolved target path on disk.
  // Lets the UI badge linked skills and show where they came from.
  linkTarget?: string
}

interface BuiltinEntry {
  name: string
  description: string
  file: string
}

const BUILTINS: BuiltinEntry[] = [
  {
    name: 'system',
    description: 'Default system prompt — diagrams-first loop, formatting rules.',
    file: 'system.txt'
  },
  {
    name: 'mdd-fixes',
    description: 'Coverage drift table the agent uses to interpret codeswim reports.',
    file: 'mdd-fixes.md'
  }
]

const SKILL_FILENAME = 'SKILL.md'

function builtinDir(): string {
  const base = app.isPackaged
    ? app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked')
    : app.getAppPath()
  return path.join(base, 'out', 'harness', 'prompt')
}

function globalDir(): string {
  return path.join(os.homedir(), '.agents', 'skills')
}

function workspaceDir(rootPath: string): string {
  return path.join(rootPath, '.agents', 'skills')
}

function isSafeSkillName(name: string): boolean {
  // Reject anything that could escape the skills dir or hide as a dotfile.
  if (!name || name.length > 120) return false
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false
  if (name.startsWith('.')) return false
  if (name === '..' || name === '.') return false
  return /^[A-Za-z0-9._ -]+$/.test(name)
}

function extractDescription(content: string): string {
  // Pull `description: ...` out of YAML frontmatter, handling both
  // single-line `description: foo` and multi-line `description: |\n  foo`.
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) {
    // No frontmatter: use the first non-empty line of body.
    const first = content.split(/\r?\n/).find((l) => l.trim().length > 0)
    return first ? first.trim().slice(0, 200) : ''
  }
  const fm = match[1]
  const lines = fm.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(/^description:\s*(.*)$/)
    if (!m) continue
    const inline = m[1].trim()
    if (inline === '|' || inline === '>' || inline === '|-' || inline === '>-') {
      // Folded/literal block — gather indented continuation lines.
      const parts: string[] = []
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]
        if (/^\s+/.test(next)) parts.push(next.trim())
        else break
      }
      return parts.join(' ').trim().slice(0, 280)
    }
    return inline.replace(/^['"]|['"]$/g, '').slice(0, 280)
  }
  return ''
}

async function readSkillDescription(skillDir: string): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(skillDir, SKILL_FILENAME), 'utf-8')
    return extractDescription(raw)
  } catch {
    return ''
  }
}

async function listSkillsInDir(
  dir: string,
  scope: 'global' | 'workspace'
): Promise<SkillSummary[]> {
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: SkillSummary[] = []
  for (const entry of entries) {
    // Accept real directories AND symlinks that resolve to one — opencode
    // follows symlinks, so we must too or the UI lies about what the agent
    // sees.
    const isDir = entry.isDirectory()
    const isLink = entry.isSymbolicLink()
    if (!isDir && !isLink) continue
    if (!isSafeSkillName(entry.name)) continue
    const skillDir = path.join(dir, entry.name)
    let linkTarget: string | undefined
    if (isLink) {
      try {
        const stat = await fs.stat(skillDir)
        if (!stat.isDirectory()) continue
        linkTarget = await fs.realpath(skillDir)
      } catch {
        // broken symlink — skip silently
        continue
      }
    }
    // Only count entries that actually contain a SKILL.md.
    try {
      await fs.access(path.join(skillDir, SKILL_FILENAME))
    } catch {
      continue
    }
    const description = await readSkillDescription(skillDir)
    out.push({ scope, name: entry.name, description, readOnly: false, linkTarget })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

async function listBuiltins(): Promise<SkillSummary[]> {
  const dir = builtinDir()
  const out: SkillSummary[] = []
  for (const entry of BUILTINS) {
    try {
      await fs.access(path.join(dir, entry.file))
      out.push({
        scope: 'builtin',
        name: entry.name,
        description: entry.description,
        readOnly: true
      })
    } catch {
      // file isn't shipped in this build — skip silently
    }
  }
  return out
}

export interface ListSkillsResult {
  builtin: SkillSummary[]
  global: SkillSummary[]
  workspace: SkillSummary[]
}

export async function listSkills(rootPath: string | null): Promise<ListSkillsResult> {
  const [builtin, global, workspace] = await Promise.all([
    listBuiltins(),
    listSkillsInDir(globalDir(), 'global'),
    rootPath ? listSkillsInDir(workspaceDir(rootPath), 'workspace') : Promise.resolve([])
  ])
  return { builtin, global, workspace }
}

function resolveSkillPath(
  scope: SkillScope,
  name: string,
  rootPath: string | null
): { absPath: string; dirToDelete?: string } {
  if (scope === 'builtin') {
    const entry = BUILTINS.find((b) => b.name === name)
    if (!entry) throw new Error(`unknown builtin skill: ${name}`)
    return { absPath: path.join(builtinDir(), entry.file) }
  }
  if (!isSafeSkillName(name)) throw new Error(`invalid skill name: ${name}`)
  if (scope === 'global') {
    const dir = path.join(globalDir(), name)
    return { absPath: path.join(dir, SKILL_FILENAME), dirToDelete: dir }
  }
  if (scope === 'workspace') {
    if (!rootPath) throw new Error('no workspace open')
    const dir = path.join(workspaceDir(rootPath), name)
    return { absPath: path.join(dir, SKILL_FILENAME), dirToDelete: dir }
  }
  throw new Error(`unknown skill scope: ${scope as string}`)
}

export async function readSkill(
  scope: SkillScope,
  name: string,
  rootPath: string | null
): Promise<string> {
  const { absPath } = resolveSkillPath(scope, name, rootPath)
  return fs.readFile(absPath, 'utf-8')
}

// Returns the directory that holds a global/workspace skill, or null for
// built-ins (which are single bundled files with no surrounding folder we
// want to expose).
function skillDir(
  scope: SkillScope,
  name: string,
  rootPath: string | null
): string | null {
  if (scope === 'builtin') return null
  if (!isSafeSkillName(name)) throw new Error(`invalid skill name: ${name}`)
  if (scope === 'global') return path.join(globalDir(), name)
  if (scope === 'workspace') {
    if (!rootPath) throw new Error('no workspace open')
    return path.join(workspaceDir(rootPath), name)
  }
  throw new Error(`unknown skill scope: ${scope as string}`)
}

// Resolves a relative path inside a skill dir to an absolute path, refusing
// anything that would escape the dir via `..` or absolute segments. Builtins
// only support the empty/SKILL-equivalent path — they don't have siblings.
function resolveInsideSkill(
  scope: SkillScope,
  name: string,
  relPath: string,
  rootPath: string | null
): string {
  if (scope === 'builtin') {
    // Built-ins surface their bundled filename (e.g. `system.txt`) as the
    // only entry in the tree. Accept that filename, the canonical SKILL.md
    // alias, or an empty path — anything else is out of bounds.
    const entry = BUILTINS.find((b) => b.name === name)
    if (!entry) throw new Error(`unknown builtin skill: ${name}`)
    if (relPath && relPath !== entry.file && relPath !== SKILL_FILENAME) {
      throw new Error('built-in skills have no other files')
    }
    return path.join(builtinDir(), entry.file)
  }
  const dir = skillDir(scope, name, rootPath)
  if (!dir) throw new Error('cannot resolve skill directory')
  const normalized = path.posix.normalize(relPath || SKILL_FILENAME).replace(/\\/g, '/')
  if (normalized.startsWith('..') || path.isAbsolute(normalized) || normalized.includes('\0')) {
    throw new Error(`invalid path inside skill: ${relPath}`)
  }
  // Resolve and double-check it's still inside the dir after symlinks.
  const abs = path.join(dir, normalized)
  const rel = path.relative(dir, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path escapes skill directory: ${relPath}`)
  }
  return abs
}

export interface SkillFileNode {
  kind: 'file' | 'dir'
  name: string
  // Relative POSIX path from the skill directory (no leading slash).
  path: string
  children?: SkillFileNode[]
}

const SKILL_TREE_IGNORE = new Set(['.DS_Store', 'Thumbs.db'])
const MAX_TREE_DEPTH = 6

async function walkSkillTree(
  dir: string,
  relPrefix: string,
  depth: number
): Promise<SkillFileNode[]> {
  if (depth > MAX_TREE_DEPTH) return []
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const nodes: SkillFileNode[] = []
  for (const entry of entries) {
    if (SKILL_TREE_IGNORE.has(entry.name)) continue
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
    const abs = path.join(dir, entry.name)
    // Resolve through symlinks so a SKILL.md that is itself linked still
    // shows up as a file, but never recurse outside the original dir.
    let isDir = entry.isDirectory()
    let isFile = entry.isFile()
    if (entry.isSymbolicLink()) {
      try {
        const st = await fs.stat(abs)
        isDir = st.isDirectory()
        isFile = st.isFile()
      } catch {
        continue
      }
    }
    if (isDir) {
      nodes.push({
        kind: 'dir',
        name: entry.name,
        path: rel,
        children: await walkSkillTree(abs, rel, depth + 1)
      })
    } else if (isFile) {
      nodes.push({ kind: 'file', name: entry.name, path: rel })
    }
  }
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return nodes
}

export async function listSkillFiles(
  scope: SkillScope,
  name: string,
  rootPath: string | null
): Promise<SkillFileNode[]> {
  if (scope === 'builtin') {
    const entry = BUILTINS.find((b) => b.name === name)
    if (!entry) throw new Error(`unknown builtin skill: ${name}`)
    return [{ kind: 'file', name: entry.file, path: entry.file }]
  }
  const dir = skillDir(scope, name, rootPath)
  if (!dir) return []
  return walkSkillTree(dir, '', 0)
}

const TEXT_BYTES_LIMIT = 2 * 1024 * 1024
const NULL_BYTE_SAMPLE = 4096

export interface SkillFileContent {
  binary: boolean
  // utf-8 decoded text when binary === false; otherwise an empty string.
  content: string
  size: number
}

export async function readSkillFile(
  scope: SkillScope,
  name: string,
  relPath: string,
  rootPath: string | null
): Promise<SkillFileContent> {
  const abs = resolveInsideSkill(scope, name, relPath, rootPath)
  const stat = await fs.stat(abs)
  if (stat.size > TEXT_BYTES_LIMIT) {
    return { binary: true, content: '', size: stat.size }
  }
  const buf = await fs.readFile(abs)
  // Cheap binary heuristic: any NUL byte in the first few KB.
  const sample = buf.subarray(0, Math.min(NULL_BYTE_SAMPLE, buf.length))
  if (sample.includes(0)) {
    return { binary: true, content: '', size: stat.size }
  }
  return { binary: false, content: buf.toString('utf-8'), size: stat.size }
}

export async function writeSkillFile(
  scope: SkillScope,
  name: string,
  relPath: string,
  content: string,
  rootPath: string | null
): Promise<void> {
  if (scope === 'builtin') throw new Error('built-in skills are read-only')
  const abs = resolveInsideSkill(scope, name, relPath, rootPath)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content, 'utf-8')
}

// Returns the absolute path of the file that backs this skill (SKILL.md for
// global/workspace, the bundled prompt file for built-ins). The renderer
// hands this to electron.shell.openPath so the OS launches the user's
// default editor for the file's extension.
export function resolveSkillFilePath(
  scope: SkillScope,
  name: string,
  rootPath: string | null,
  relPath?: string
): string {
  if (relPath && relPath !== SKILL_FILENAME) {
    return resolveInsideSkill(scope, name, relPath, rootPath)
  }
  const { absPath } = resolveSkillPath(scope, name, rootPath)
  return absPath
}

export async function writeSkill(
  scope: SkillScope,
  name: string,
  content: string,
  rootPath: string | null
): Promise<void> {
  if (scope === 'builtin') throw new Error('built-in skills are read-only')
  const { absPath } = resolveSkillPath(scope, name, rootPath)
  await fs.mkdir(path.dirname(absPath), { recursive: true })
  await fs.writeFile(absPath, content, 'utf-8')
}

export async function deleteSkill(
  scope: SkillScope,
  name: string,
  rootPath: string | null
): Promise<void> {
  if (scope === 'builtin') throw new Error('built-in skills are read-only')
  const { dirToDelete } = resolveSkillPath(scope, name, rootPath)
  if (!dirToDelete) throw new Error('cannot resolve skill directory')
  // For symlinks, unlink the link only — never recurse into the target.
  // For real directories, remove the whole tree (skills can carry sibling
  // files like `rules/` or scripts alongside SKILL.md).
  let stat: import('fs').Stats | null = null
  try {
    stat = await fs.lstat(dirToDelete)
  } catch {
    throw new Error(`skill not found: ${scope}/${name}`)
  }
  if (stat.isSymbolicLink()) {
    await fs.unlink(dirToDelete)
    return
  }
  await fs.rm(dirToDelete, { recursive: true, force: true })
}

export interface LinkFolderResult {
  linked: string[]
  skipped: Array<{ name: string; reason: string }>
}

// Scans `sourcePath` for direct child directories that contain a SKILL.md
// and creates a symlink for each one inside the target scope's skills dir.
// On collision the existing entry wins and we report it as skipped — we
// never overwrite a real skill (or a previously-linked one) silently.
export async function linkFolder(
  scope: 'global' | 'workspace',
  sourcePath: string,
  rootPath: string | null
): Promise<LinkFolderResult> {
  const targetDir = scope === 'global' ? globalDir() : workspaceDir(rootPath ?? '')
  if (scope === 'workspace' && !rootPath) throw new Error('no workspace open')

  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(sourcePath, { withFileTypes: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`could not read source folder: ${msg}`)
  }

  await fs.mkdir(targetDir, { recursive: true })

  const linked: string[] = []
  const skipped: LinkFolderResult['skipped'] = []

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const name = entry.name
    const childAbs = path.resolve(sourcePath, name)

    // Resolve to make sure it's actually a directory containing SKILL.md.
    try {
      const stat = await fs.stat(childAbs)
      if (!stat.isDirectory()) {
        skipped.push({ name, reason: 'not a directory' })
        continue
      }
      await fs.access(path.join(childAbs, SKILL_FILENAME))
    } catch {
      skipped.push({ name, reason: 'no SKILL.md' })
      continue
    }

    if (!isSafeSkillName(name)) {
      skipped.push({ name, reason: 'invalid skill name' })
      continue
    }

    const linkAt = path.join(targetDir, name)
    // Refuse to overwrite anything that already exists, real or linked.
    try {
      await fs.lstat(linkAt)
      skipped.push({ name, reason: 'already exists' })
      continue
    } catch {
      // not present — proceed
    }

    try {
      await fs.symlink(childAbs, linkAt, 'dir')
      linked.push(name)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      skipped.push({ name, reason: `symlink failed: ${msg}` })
    }
  }

  return { linked, skipped }
}
