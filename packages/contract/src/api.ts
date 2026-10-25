import type { KanbanBoard } from './kanban'
import type { PersistedAgentTabs } from './agent-tabs'
import type { CommandRendererRequest, CommandRendererResponse } from './commands'
import type { ScreenContextV2 } from './screen-context'

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

// The whiteboard narrator's opencode server (main/sidecar.ts,
// startNarratorSidecar). `directory` is the empty directory its sessions run
// in; every request must pass it, never a workspace root.
export interface WhiteboardConnection {
  url: string
  directory: string
}

// The whiteboard's natural voice (Kokoro, main/voice.ts). `installed` means
// the model is on disk; `state` is the voice process: 'downloading' and
// 'loading' while install runs, 'ready' once it can speak. `available` is
// false where there's no voice process at all (the browser stub).
export interface VoiceStatus {
  available: boolean
  installed: boolean
  state: 'idle' | 'downloading' | 'loading' | 'ready' | 'error'
  /** 0..1 while downloading, otherwise null. */
  progress: number | null
  error: string | null
  downloadMb: number
}

// Speech mode's speech recognition (main/listen.ts): the same lifecycle as
// the natural voice, an opt-in download, then offline.
export type ListenStatus = VoiceStatus

// One spoken sentence as mono PCM.
export interface SpokenAudio {
  samples: Float32Array
  sampleRate: number
}

// The browser panel (main/browser-host.ts): one sandboxed page view inside
// the app window. `url` is '' until something is opened; `error` is the last
// main-frame load failure (the view is hidden while it's set, so the panel
// can say what went wrong).
export interface BrowserState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error: string | null
}

// Where the page view sits, in CSS pixels relative to the window's content.
export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface PageBox {
  x: number
  y: number
  width: number
  height: number
}

// One visible element worth talking about: a heading, button, link, input or
// image. `ref` (e1, e2, ...) addresses it in later browser calls until the
// page navigates. Sizes are CSS pixels; `style` is a few computed properties
// (font size, colors, padding, radius) for buttons, links and inputs.
export interface PageElement {
  ref: string
  role: string
  text: string
  box: PageBox
  href?: string
  style?: Record<string, string>
}

// A bounded, text-only picture of the open page — cheap enough to put in a
// prompt on every request. `text` is the page's visible text, cut short.
export interface PageOutline {
  url: string
  title: string
  viewport: { width: number; height: number; scrollY: number; pageHeight: number }
  elements: PageElement[]
  text: string
  truncated: boolean
}

// What point/measure found for one target (visible text, a ref, or a CSS
// selector).
export interface PageMatch {
  target: string
  found: boolean
  element?: PageElement
}

export interface PageScreenshot {
  // Workspace-relative path of the PNG (under .codeswim/browser/).
  path: string
  width: number
  height: number
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

// A Kanban "Run all" worktree that still exists on disk, with how much
// uncommitted agent work is sitting in it. Nothing auto-commits these — the
// user syncs a card branch when they're ready, from the Sync panel.
export interface KanbanWorktreeInfo {
  cardId: string
  path: string
  branch: string | null
  // Staged + unstaged + untracked paths, so the UI can say "4 changes".
  changeCount: number
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
  publicRoomId: string
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

// Claude Code IDE bridge (apps/desktop/src/main/claude-ide.ts): Codeswim
// plays the part VS Code's Claude extension does for a `claude` CLI running
// in the Claude Code tab — it serves the CLI's IDE MCP tools, so the CLI can
// see what's open/selected here and route its proposed edits through our
// diff view for accept/reject. Lines/characters are 0-based, as the CLI
// expects; the renderer converts from CodeMirror's 1-based lines.
export interface ClaudeIdePosition {
  line: number
  character: number
}

export interface ClaudeIdeSelection {
  start: ClaudeIdePosition
  end: ClaudeIdePosition
  isEmpty: boolean
}

// What the renderer reports whenever the open file or its selection changes.
export interface ClaudeIdeEditorState {
  // Absolute path of the file in the code view, or null when none is open.
  filePath: string | null
  selection: ClaudeIdeSelection | null
  text: string
}

// The CLI asked to open a file (optionally at a text match). Main resolves the
// match to a 1-based line range; relPath is root-relative posix.
export interface ClaudeIdeOpenFile {
  relPath: string
  range: { start: number; end: number } | null
}

// A proposed edit awaiting accept/reject. `diff` is a unified diff of the
// file on disk against the CLI's proposed contents.
export interface ClaudeIdeDiff {
  tabName: string
  relPath: string
  diff: string
}

// "Sign in with Unbiased" (packages/domain-unbiased). The Pareto API key the
// device flow mints goes straight from main into opencode's auth store and
// never crosses IPC; the renderer only sees these display labels.
export interface UnbiasedAccount {
  workloadName: string
  keyName: string
  // Approving member's profile name; null when the platform didn't send one.
  userName: string | null
  signedInAt: string
}

// What to show while the user approves in the browser. Show both the code
// and the URL even though the browser opens itself — it may not have.
export interface UnbiasedSignInPending {
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresAt: number
}

export interface UnbiasedStatus {
  account: UnbiasedAccount | null
  pending: UnbiasedSignInPending | null
}

// Pushed when a background sign-in finishes: 'signed-in' once the key is in
// opencode's auth store, 'error' with user-facing copy otherwise.
export type UnbiasedAuthEvent =
  | { status: 'signed-in'; account: UnbiasedAccount }
  | { status: 'signed-out' }
  | { status: 'error'; message: string }

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

// The legacy (unversioned) shape published to `.codeswim/agent-state.json`
// before ScreenContextV2 (packages/contract/src/screen-context.ts). Kept for
// one release purely so formatAppState (packages/harness/src/tool/app-view.ts)
// can still parse a snapshot written by an older build — nothing writes this
// shape anymore.
export interface AppStateSnapshot {
  workspaceView: 'navigator' | 'kanban' | 'agents'
  currentFile: string | null
  currentDocumentPath: string | null
  view: 'diagram' | 'read' | 'code' | 'output' | 'diff'
  breadcrumbs: string[]
  runningScript: string | null
}

export interface DiagramNavApi {
  pickFolder(): Promise<string | null>
  readFile(absPath: string): Promise<string>
  // Root-scoped read: relPath is resolved inside rootPath and rejected if it
  // escapes (symlinks included). This is the read path exposed to the
  // command bus's generic run_command — readFile above takes an unrestricted
  // absolute path and must never be reachable from a command an agent can
  // invoke by id.
  readWorkspaceFile(rootPath: string, relPath: string): Promise<string>
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
  // "Run all": creates an isolated git worktree + branch for a card so its
  // agent run can't collide with the main working tree or another card's
  // worktree. The branch is left for manual review — nothing auto-merges.
  kanbanWorktreeCreate(
    rootPath: string,
    cardId: string,
    cardTitle: string
  ): Promise<{ path: string; branch: string }>
  kanbanWorktreeRemove(rootPath: string, cardId: string): Promise<void>
  // Every card worktree currently on disk for this workspace. Used by the Sync
  // panel to offer each card branch as a sync target.
  kanbanWorktreeList(rootPath: string): Promise<KanbanWorktreeInfo[]>
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
  // Command bridge (main/command-server.ts): main proxies the harness's
  // find_command/run_command/open_file HTTP calls to the renderer's command
  // registry over this request/reply pair, correlated by CommandRendererRequest.id.
  onCommandRequest(cb: (request: CommandRendererRequest) => void): () => void
  replyCommand(response: CommandRendererResponse): Promise<void>
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
  // .codeswim/hooks.json (workspace-only), surfaced and edited from the
  // Tools → Hooks tab. See packages/harness/src/hooks.ts for the runtime
  // reader this config feeds.
  hooksRead(rootPath: string | null): Promise<AgentsDocContent>
  hooksWrite(rootPath: string | null, content: string): Promise<void>
  hooksOpenInEditor(rootPath: string | null): Promise<void>
  // .codeswim/spec-ignore (workspace-only, .gitignore-style text file) —
  // paths (files or whole directories, root-relative posix) the user has
  // right-clicked "Ignore for specs" on in the file tree. Read once per workspace open;
  // written back in full on every toggle. Consulted by both the per-file
  // "not explained yet" banner (CodeView) and the Sync/coverage report
  // (uncoveredSources / orphanDiagrams) so the app stops nagging about
  // files that were never meant to have a codeswim companion doc — e.g.
  // another tool's own spec files.
  coverageIgnoreRead(rootPath: string): Promise<string[]>
  coverageIgnoreWrite(rootPath: string, paths: string[]): Promise<void>
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
  // Unbiased sign-in. signIn starts the device flow (rootPath picks the
  // harness whose auth store receives the key) and returns the code to show;
  // completion arrives via onUnbiasedAuthChanged.
  unbiasedStatus(): Promise<UnbiasedStatus>
  unbiasedSignIn(rootPath: string): Promise<UnbiasedSignInPending | { error: string }>
  unbiasedCancelSignIn(): Promise<void>
  unbiasedSignOut(rootPath: string): Promise<void>
  onUnbiasedAuthChanged(cb: (event: UnbiasedAuthEvent) => void): () => void
  // Claude Code IDE bridge — see ClaudeIdeEditorState above.
  claudeIdeReportEditor(state: ClaudeIdeEditorState): void
  claudeIdeResolveDiff(tabName: string, accepted: boolean): Promise<void>
  onClaudeIdeOpenFile(cb: (req: ClaudeIdeOpenFile) => void): () => void
  onClaudeIdeShowDiff(cb: (diff: ClaudeIdeDiff) => void): () => void
  // null closes every Claude diff.
  onClaudeIdeCloseDiff(cb: (tabName: string | null) => void): () => void
  terminalCreate(cwd?: string, command?: string): Promise<string>
  terminalWrite(id: string, data: string): void
  terminalResize(id: string, cols: number, rows: number): void
  terminalDestroy(id: string): void
  onTerminalData(cb: (id: string, data: string) => void): () => void
  onTerminalExit(cb: (id: string) => void): () => void
  // Publishes the renderer's current screen context so the agent's
  // get_app_state tool can read what the user is looking at. Best-effort,
  // fire-and-forget.
  publishAgentState(rootPath: string, context: ScreenContextV2): Promise<void>
  // Agents-view tab strip persistence (id/sessionId/title only — see
  // PersistedAgentTabs). null from read means no file yet / unreadable.
  agentTabsRead(rootPath: string): Promise<PersistedAgentTabs | null>
  agentTabsWrite(rootPath: string, data: PersistedAgentTabs): Promise<void>
  // Talking whiteboard (plans/talking-whiteboard.md). whiteboardStart starts
  // (or reuses) the narrator's own opencode process; read/write persist the
  // board and conversation to .codeswim/whiteboard/board.json as an opaque
  // JSON string the renderer validates. null from read means no saved board.
  whiteboardStart(): Promise<WhiteboardConnection>
  whiteboardRead(rootPath: string): Promise<string | null>
  whiteboardWrite(rootPath: string, json: string): Promise<void>
  // The whiteboard's natural voice (Kokoro). voiceInstall downloads the model
  // on first use (~163 MB, into userData) and loads it; voiceSpeak turns one
  // sentence into PCM; voiceCancel drops sentences not yet synthesized.
  voiceStatus(): Promise<VoiceStatus>
  voiceInstall(): Promise<VoiceStatus>
  // `background`: a phrase rendered ahead of time, behind real sentences.
  voiceSpeak(
    text: string,
    voice: string,
    speed?: number,
    background?: boolean
  ): Promise<SpokenAudio>
  voiceCancel(): Promise<void>
  onVoiceStatus(cb: (status: VoiceStatus) => void): () => void
  // Speech mode (main/listen.ts). listenTranscribe takes one utterance as
  // 16 kHz mono PCM. micAccess asks the OS for the microphone (macOS shows
  // its prompt once) and says whether it was granted.
  listenStatus(): Promise<ListenStatus>
  listenInstall(): Promise<ListenStatus>
  listenTranscribe(samples: Float32Array): Promise<string>
  onListenStatus(cb: (status: ListenStatus) => void): () => void
  micAccess(): Promise<boolean>
  // The browser panel (main/browser-host.ts). browserOpen accepts http(s)
  // URLs (a bare "localhost:5173" gets http://); browserSetBounds places the
  // page view over the panel's viewport, null hides it (the page keeps
  // running). Inspect/point/measure run in an isolated world, so the page's
  // own scripts never see them; screenshots land in <root>/.codeswim/browser/.
  browserOpen(url: string): Promise<BrowserState>
  browserNavigate(action: 'back' | 'forward' | 'reload' | 'stop'): Promise<BrowserState>
  browserState(): Promise<BrowserState>
  browserSetBounds(bounds: BrowserBounds | null): Promise<void>
  browserClose(): Promise<void>
  browserInspect(): Promise<PageOutline>
  browserPoint(target: string, all?: boolean): Promise<PageMatch[]>
  browserMeasure(targets: string[]): Promise<PageMatch[]>
  browserScreenshot(rootPath: string): Promise<PageScreenshot>
  // Reload and wait (bounded) for the page to finish loading.
  browserReload(): Promise<BrowserState>
  onBrowserState(cb: (state: BrowserState) => void): () => void
  // App auto-update: main checks + downloads on its own; the renderer listens
  // for status and calls installUpdate to restart into the new version.
  onUpdateStatus(cb: (payload: UpdateStatusPayload) => void): () => void
  installUpdate(): Promise<void>
}
