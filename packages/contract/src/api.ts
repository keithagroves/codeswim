import type { KanbanBoard } from './kanban'

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

// App auto-update lifecycle, VS Code-style: the main process checks and
// downloads in the background; the renderer only shows a "restart to update"
// affordance once a new version is ready to install.
export interface UpdateStatusPayload {
  state: 'checking' | 'available' | 'downloading' | 'ready' | 'none' | 'error'
  // Version the update refers to ('available' | 'downloading' | 'ready').
  version?: string
  // Percent 0-100 while 'downloading'.
  percent?: number
  // Human-readable message when 'error'.
  message?: string
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

export type AgentsScope = 'workspace' | 'global'

export interface AgentsDocContent {
  content: string
  exists: boolean
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

export interface GitSyncResult {
  remote: boolean
  pushed: boolean
  branch: string | null
  conflict: boolean
  error?: string
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

export interface GitHubUser {
  id: number
  login: string
  name: string | null
  avatarUrl: string | null
}

export interface GitHubStatus {
  // false when GITHUB_CLIENT_ID is unset — sign-in is unavailable.
  configured: boolean
  user: GitHubUser | null
}

export interface GitHubSignInResult {
  userCode: string
  verificationUri: string
}

export interface PullRequest {
  number: number
  title: string
  state: 'open' | 'closed'
  draft: boolean
  url: string
  author: string | null
  authorAvatarUrl: string | null
  createdAt: string
  updatedAt: string
  baseRef: string
  headRef: string
  comments: number
}

export interface PullRequestList {
  // 'ok' with the PRs, or a reason the list is empty/unavailable:
  // 'not-github' (no GitHub remote), 'no-auth' (private/rate-limited and not
  // signed in), or 'error' with a message.
  status: 'ok' | 'not-github' | 'no-auth' | 'error'
  slug: string | null
  pulls: PullRequest[]
  error?: string
}

export type MergeMethod = 'merge' | 'squash' | 'rebase'

export interface MergeResult {
  // 'merged' on success; 'blocked' when GitHub refuses (conflicts, failing
  // checks, branch protection); 'no-auth' without write access; 'not-github'
  // for a non-GitHub remote; 'error' for transport/unknown failures.
  status: 'merged' | 'blocked' | 'no-auth' | 'not-github' | 'error'
  message?: string
}

export interface PullRequestDiff {
  status: 'ok' | 'no-auth' | 'not-github' | 'error'
  diff: string
  message?: string
}

// Snapshot of the renderer's UI state, published to `.codeswim/agent-state.json`
// so the harness `get_app_state` tool (a separate process) can read what the
// user is currently looking at. Paths are POSIX-relative to the workspace root.
export interface AppStateSnapshot {
  workspaceView: 'navigator' | 'kanban' | 'agents'
  currentFile: string | null
  currentDocumentPath: string | null
  view: 'diagram' | 'read' | 'output' | 'diff'
  breadcrumbs: string[]
  runningScript: string | null
}

// Actions the agent emits (as tool-result metadata under `codeswim_action`) to
// drive the navigator. The renderer dispatches these off the live part stream.
export type AgentViewAction =
  | { type: 'open_file'; path: string }
  | { type: 'set_view'; view: 'navigator' | 'kanban' }

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
  // Copies the bundled example project into userData (first time) and returns
  // its path, ready to open as a normal workspace.
  openDemo(): Promise<string>
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
  // AGENTS.md (workspace root or global ~/.agents), surfaced and edited from
  // the Tools → Context tab.
  agentsDocRead(scope: AgentsScope, rootPath: string | null): Promise<AgentsDocContent>
  agentsDocWrite(scope: AgentsScope, content: string, rootPath: string | null): Promise<void>
  agentsDocOpenInEditor(scope: AgentsScope, rootPath: string | null): Promise<void>
  gitStatus(rootPath: string): Promise<GitStatus>
  gitStagedDiff(rootPath: string): Promise<string>
  gitWorkingDiff(rootPath: string): Promise<string>
  gitFileDiff(rootPath: string, filePath: string): Promise<string>
  gitPush(rootPath: string): Promise<GitSyncResult>
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
  // GitHub auth for chat. signIn starts the OAuth device flow and returns the
  // code to display; completion arrives later via onGitHubAuthChanged.
  githubStatus(): Promise<GitHubStatus>
  githubSignIn(): Promise<GitHubSignInResult | { error: string }>
  githubSignOut(): Promise<void>
  githubToken(): Promise<string | null>
  listPullRequests(rootPath: string, state?: 'open' | 'closed' | 'all'): Promise<PullRequestList>
  mergePullRequest(rootPath: string, number: number, method?: MergeMethod): Promise<MergeResult>
  pullRequestDiff(rootPath: string, number: number): Promise<PullRequestDiff>
  onGitHubAuthChanged(cb: (user: GitHubUser | null) => void): () => void
  terminalCreate(cwd?: string, command?: string): Promise<string>
  terminalWrite(id: string, data: string): void
  terminalResize(id: string, cols: number, rows: number): void
  terminalDestroy(id: string): void
  onTerminalData(cb: (id: string, data: string) => void): () => void
  onTerminalExit(cb: (id: string) => void): () => void
  // Publishes the renderer's current UI state so the agent's get_app_state tool
  // can read what the user is looking at. Best-effort, fire-and-forget.
  publishAgentState(rootPath: string, snapshot: AppStateSnapshot): Promise<void>
  // App auto-update: main checks + downloads on its own; the renderer listens
  // for status and calls installUpdate to restart into the new version.
  onUpdateStatus(cb: (payload: UpdateStatusPayload) => void): () => void
  installUpdate(): Promise<void>
}
