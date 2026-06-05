import { ElectronAPI } from '@electron-toolkit/preload'

export interface ScriptOutputPayload {
  name: string
  stream: 'stdout' | 'stderr'
  chunk: string
}

export interface ScriptExitPayload {
  name: string
  code: number | null
  signal: NodeJS.Signals | null
}

export interface TreeNode {
  kind: 'file' | 'dir'
  name: string
  path: string
  children?: TreeNode[]
}

export interface HarnessConnection {
  url: string
}

export interface HarnessLogPayload {
  stream: 'stdout' | 'stderr'
  line: string
}

export interface HarnessExitPayload {
  code: number | null
  signal: string | null
  stderrTail: string[]
}

export interface NewProjectResult {
  path: string
  created: boolean
}

export interface RunEntry {
  source: 'npm' | 'custom'
  name: string
  command: string
  description?: string
}

export type SkillScope = 'global' | 'workspace' | 'builtin'

export interface SkillFileNode {
  kind: 'file' | 'dir'
  name: string
  path: string
  children?: SkillFileNode[]
}

export interface SkillFileContent {
  binary: boolean
  content: string
  size: number
}

export interface SkillSummary {
  scope: SkillScope
  name: string
  description: string
  readOnly: boolean
  linkTarget?: string
}

export interface SkillListResult {
  builtin: SkillSummary[]
  global: SkillSummary[]
  workspace: SkillSummary[]
}

export interface LinkFolderResult {
  linked: string[]
  skipped: Array<{ name: string; reason: string }>
}

export interface GitFileChange {
  path: string
  index: string
  worktree: string
}

export interface GitStatus {
  isRepo: boolean
  branch: string | null
  staged: GitFileChange[]
  unstaged: GitFileChange[]
  untracked: string[]
  clean: boolean
}

export interface GitInitResult {
  createdGitignore: boolean
}

export interface DiagramNavApi {
  pickFolder(): Promise<string | null>
  readFile(absPath: string): Promise<string>
  listMarkdown(rootPath: string): Promise<string[]>
  listTree(rootPath: string): Promise<TreeNode[]>
  watch(rootPath: string): Promise<void>
  unwatch(): Promise<void>
  onFileChanged(cb: (absPath: string) => void): () => void
  onTreeChanged(cb: () => void): () => void
  listRuns(rootPath: string): Promise<RunEntry[]>
  runEntry(rootPath: string, source: 'npm' | 'custom', name: string): Promise<void>
  killScript(): Promise<void>
  onScriptOutput(cb: (payload: ScriptOutputPayload) => void): () => void
  onScriptExit(cb: (payload: ScriptExitPayload) => void): () => void
  startHarness(rootPath: string): Promise<HarnessConnection>
  stopHarness(): Promise<void>
  onHarnessLog(cb: (payload: HarnessLogPayload) => void): () => void
  onHarnessExit(cb: (payload: HarnessExitPayload) => void): () => void
  onMenuOpenFolder(cb: () => void): () => void
  newProject(): Promise<NewProjectResult | null>
  getRecents(): Promise<string[]>
  clearRecents(): Promise<string[]>
  addRecent(path: string): Promise<string[]>
  onMenuNewProject(cb: () => void): () => void
  onMenuOpenRecent(cb: (path: string) => void): () => void
  onMenuRecentsCleared(cb: () => void): () => void
  listSkills(rootPath: string | null): Promise<SkillListResult>
  readSkill(scope: SkillScope, name: string, rootPath: string | null): Promise<string>
  writeSkill(
    scope: SkillScope,
    name: string,
    content: string,
    rootPath: string | null
  ): Promise<void>
  deleteSkill(scope: SkillScope, name: string, rootPath: string | null): Promise<void>
  pickSkillLinkSource(): Promise<string | null>
  linkSkillFolder(
    scope: 'global' | 'workspace',
    sourcePath: string,
    rootPath: string | null
  ): Promise<LinkFolderResult>
  openSkillInEditor(
    scope: SkillScope,
    name: string,
    rootPath: string | null,
    relPath?: string
  ): Promise<void>
  listSkillFiles(scope: SkillScope, name: string, rootPath: string | null): Promise<SkillFileNode[]>
  readSkillFile(
    scope: SkillScope,
    name: string,
    relPath: string,
    rootPath: string | null
  ): Promise<SkillFileContent>
  writeSkillFile(
    scope: SkillScope,
    name: string,
    relPath: string,
    content: string,
    rootPath: string | null
  ): Promise<void>
  gitStatus(rootPath: string): Promise<GitStatus>
  gitStagedDiff(rootPath: string): Promise<string>
  gitCommit(rootPath: string, subject: string, body: string): Promise<string>
  gitInit(rootPath: string): Promise<GitInitResult>
  gitStageAll(rootPath: string): Promise<void>
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: DiagramNavApi
  }
}
