import { ElectronAPI } from '@electron-toolkit/preload'
import type { KanbanBoard } from '../shared/kanban'

export type {
  KanbanBoard,
  KanbanCard,
  KanbanColumn,
  KanbanGitHubConfig,
  KanbanPriority
} from '../shared/kanban'

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

export interface SourceExplanation {
  sourcePath: string
  documentPath: string
  content: string
  exists: boolean
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

export interface GitIgnoreResult {
  // Patterns actually appended to .gitignore (ones already present are skipped).
  added: string[]
  // Paths that had to be `git rm --cached` because they were already tracked.
  untracked: string[]
}

export interface GitCommitEntry {
  hash: string
  shortHash: string
  author: string
  date: string
  subject: string
  body: string
  synthesized: boolean
}

export interface RoomIdentity {
  roomId: string
  slug: string
  provider: 'github' | 'git'
}

export interface DiagramNavApi {
  pickFolder(): Promise<string | null>
  readFile(absPath: string): Promise<string>
  readSourceExplanation(rootPath: string, sourcePath: string): Promise<SourceExplanation>
  openWorkspaceFile(rootPath: string, relPath: string): Promise<void>
  listMarkdown(rootPath: string): Promise<string[]>
  listTree(rootPath: string): Promise<TreeNode[]>
  kanbanRead(rootPath: string): Promise<KanbanBoard>
  kanbanWrite(rootPath: string, board: KanbanBoard): Promise<KanbanBoard>
  kanbanGitHubSync(rootPath: string, board: KanbanBoard): Promise<KanbanBoard>
  kanbanGitHubMove(
    rootPath: string,
    board: KanbanBoard,
    cardId: string,
    columnId: string
  ): Promise<void>
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
  gitWorkingDiff(rootPath: string): Promise<string>
  gitCommit(rootPath: string, subject: string, body: string): Promise<string>
  gitCommitGroup(rootPath: string, paths: string[], subject: string, body: string): Promise<string>
  gitAddToGitignore(rootPath: string, patterns: string[]): Promise<GitIgnoreResult>
  gitInit(rootPath: string): Promise<GitInitResult>
  gitStageAll(rootPath: string): Promise<void>
  gitUnstageAll(rootPath: string): Promise<void>
  gitLog(rootPath: string, limit?: number): Promise<GitCommitEntry[]>
  // Stable chat-room identity derived from the repo's origin remote, or null
  // when the workspace has no shared remote to key a room on.
  roomIdentity(rootPath: string): Promise<RoomIdentity | null>
  terminalCreate(cwd?: string): Promise<string>
  terminalWrite(id: string, data: string): void
  terminalResize(id: string, cols: number, rows: number): void
  terminalDestroy(id: string): void
  onTerminalData(cb: (id: string, data: string) => void): () => void
  onTerminalExit(cb: (id: string) => void): () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: DiagramNavApi
  }
}
