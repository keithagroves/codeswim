import { createContext, useContext } from 'react'
import type { ConfiguredProvider, PendingQuestion, SelectedModel } from './agent'
import type { CommitMessage } from '@codeswim/commit'
import type { SyncPlan } from '@codeswim/commit'
import type {
  AgentsDocContent,
  AgentsScope,
  CommandDescriptor,
  CommandOrigin,
  GitCommitEntry,
  GitHubSignInResult,
  GitHubStatus,
  GitIgnoreResult,
  GitInitResult,
  GitStatus,
  GitSyncResult,
  KanbanBoard,
  KanbanCard,
  KanbanWorktreeInfo,
  LinkFolderResult,
  MergeMethod,
  MergeResult,
  PullRequest,
  PullRequestList,
  RoomIdentity,
  SkillFileContent,
  SkillFileNode,
  SkillListResult,
  SkillScope
} from '@codeswim/contract'
import type { LineRange } from './path-utils'
import type { SurfaceContextRegistry } from './context/surface-context'
import type { GitSyncOutcome } from './commands/git'

export type { LineRange } from './path-utils'

export type { ConfiguredModel, ConfiguredProvider, PendingQuestion, SelectedModel } from './agent'
export type { CommitMessage } from '@codeswim/commit'

// Label used for a PR's diff in the main-panel diff viewer. Doubles as the
// dedup key (compared against state.diffPath to highlight the active row);
// numbers are unique, so this is stable. Lives here rather than in the panel
// component so both the panel and the store can import it without tripping the
// fast-refresh only-components rule.
export function prDiffLabel(pr: { number: number; title: string }): string {
  return `#${pr.number} · ${pr.title}`
}

export type View = 'diagram' | 'read' | 'code' | 'output' | 'diff'
export type FileView = 'diagram' | 'read' | 'code'
export type WorkspaceView = 'kanban' | 'navigator' | 'agents'
// Activity-bar / side-panel sections, in no particular order. The user's
// preferred order lives in AppState.activityOrder.
export type Section =
  | 'agent'
  | 'files'
  | 'search'
  | 'coverage'
  | 'tools'
  | 'git'
  | 'pulls'
  | 'terminal'
  | 'claude'
  | 'chat'
// Sub-tabs within the Tools section. 'skills' lists user skills; 'hooks' is
// the .codeswim/hooks.json editor (SessionStart hooks that extend the system
// prompt); 'context' holds the agent instructions (local + global
// AGENTS.md) and the built-in system prompts. MCP will get its own
// top-level section once it's implemented, not a Tools sub-tab.
export type ToolsTab = 'skills' | 'hooks' | 'context'

export interface Toast {
  id: number
  kind: 'info' | 'error'
  message: string
}

export type RunStatus = 'running' | 'exited'

export interface RunningScript {
  name: string
  status: RunStatus
  exitCode: number | null
  signal: string | null
  output: string
  startedAt: number
}

export interface RunEntry {
  source: 'npm' | 'custom'
  name: string
  command: string
  description?: string
}

export interface TreeNode {
  kind: 'file' | 'dir'
  name: string
  path: string
  children?: TreeNode[]
}

export type ChatStatus = 'idle' | 'connecting' | 'ready' | 'thinking' | 'error'

export interface SessionInfo {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface ChatMessagePart {
  id?: string
  kind: 'text' | 'tool' | 'reasoning' | 'unknown'
  text?: string
  tool?: string
  status?: 'running' | 'completed' | 'error'
  metadata?: unknown
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  parts: ChatMessagePart[]
}

// One browser-style tab in the Agents workspace view. Each tab is its own
// opencode session with an independent message log, so several agents can run
// side by side. `sessionId` is null until the first message creates the
// session lazily.
export interface AgentTab {
  id: string
  sessionId: string | null
  title: string
  status: ChatStatus
  error: string | null
  messages: ChatMessage[]
  pendingQuestion: PendingQuestion | null
  // Overrides rootPath as the opencode session's working directory — set for
  // tabs opened by Kanban "Run all", which run in an isolated git worktree
  // rather than the main workspace. null for ordinary tabs.
  directory: string | null
}

// Flatten the file tree to a list of root-relative file paths, for resolving
// path-like tokens in agent output (directories are dropped — only files are
// navigable targets). Shared by the chat panel and the Agents view.
export function flattenTreeFiles(tree: TreeNode[] | null): string[] {
  if (!tree) return []
  const out: string[] = []
  const walk = (nodes: TreeNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'file') out.push(node.path)
      else if (node.children) walk(node.children)
    }
  }
  walk(tree)
  return out
}

export interface AppState {
  rootPath: string | null
  workspaceView: WorkspaceView
  currentFile: string | null
  // Markdown document currently rendered for currentFile. For source
  // leaves this is the companion explanation path.
  currentDocumentPath: string | null
  sourceExplanationExists: boolean
  // Companion explanation prose for the current source file, rendered as a
  // banner above the code in CodeView. Null for markdown files (they render
  // their own content) or when no explanation doc exists yet.
  explanationContent: string | null
  breadcrumbs: string[]
  // Browser-style forward history. Populated when the user goes Back; cleared
  // on any fresh navigation. Lets the Forward button retrace.
  forward: string[]
  view: View
  fileContents: string | null
  // Line range to highlight/scroll to in the `code` view. Set only by
  // openSourceCode; navigation elsewhere clears it.
  codeRange: LineRange | null
  loading: boolean
  toasts: Toast[]
  runs: RunEntry[]
  runningScript: RunningScript | null
  // The view we should return to when the user closes the output/diff panel.
  prevView: FileView | null
  // Main-panel diff viewer (Sync → click a changed file). diffPath is the repo-
  // relative path being shown; diffContent is the raw unified diff (null while
  // loading, '' when there's nothing to show).
  diffPath: string | null
  diffContent: string | null
  diffLoading: boolean
  tree: TreeNode[] | null
  // Side-panel layout. ActivityBar lives at the very left and stays
  // visible; SidePanel sits to its right and shows whichever section is
  // active. null = side panel collapsed (icons only, like VS Code).
  activeSection: Section | null
  // Remembers which section was last open so toggling the panel closed
  // and back open restores it (rather than always returning to 'files').
  lastActiveSection: Section
  // Side panel width in pixels. Persisted to localStorage so it survives
  // reloads.
  sidePanelWidth: number
  // User-controlled order of activity-bar sections (drag-to-reorder).
  // Persisted to localStorage.
  activityOrder: Section[]
  // Which sub-tab of the Tools section is active (skills vs MCP).
  toolsTab: ToolsTab
  // Selected skill in the Skills view (null = nothing picked yet).
  // linkTarget is set when the skill directory is a symlink, so the view
  // can show where it came from and adjust delete messaging. `file` is the
  // POSIX-relative path of the file currently being viewed inside the
  // skill — defaults to SKILL.md when omitted. `kind: 'agents'` flags the
  // workspace AGENTS.md, which loads/saves through the agents-doc IPC
  // instead of the per-skill file IPC.
  currentSkill: {
    kind?: 'skill' | 'agents'
    scope: 'global' | 'workspace' | 'builtin'
    name: string
    linkTarget?: string
    file?: string
  } | null
  chatStatus: ChatStatus
  chatError: string | null
  chatMessages: ChatMessage[]
  chatSettingsOpen: boolean
  sessions: SessionInfo[]
  currentSessionId: string | null
  recents: string[]
  // Most recent unanswered question opencode raised for the current
  // session. Cleared on reply/reject or when switching sessions.
  pendingQuestion: PendingQuestion | null
  // Activity-bar badge counts, fetched in the store independently of whether
  // the matching panel is mounted (panels only mount while active). The git
  // count is unique changed paths in the working tree; the PR count is open
  // pull requests. Like VS Code's sidebar badges.
  changeCount: number
  openPrCount: number
  // Tabs in the Agents workspace view (header tab next to Explore/Plan).
  agentTabs: AgentTab[]
  activeAgentTabId: string | null
  // Provider/model pinned to new chat sends, app-wide (all tabs share it —
  // see the model-switcher dropdown in ChatPanel/AgentsView). null until
  // ensureAgent's first connect resolves a default. Persisted to localStorage.
  selectedModel: SelectedModel | null
  // Providers opencode already has credentials for, with their model lists.
  // Populated on connect — this is what the model-switcher lists, so
  // switching models never re-prompts for an API key.
  availableProviders: ConfiguredProvider[]
  // Root-relative posix paths (files or whole directories) the user has
  // right-clicked "Ignore for spec coverage" on in the file tree — see
  // coverage/ignore.ts. Excluded from the Sync/coverage report and from
  // CodeView's "not explained yet" nag.
  coverageIgnore: string[]
}

// Structural shape of the command registry (apps/desktop/src/renderer/src/
// commands/registry.ts) exposed through StoreApi. Declared here rather than
// importing CommandRegistry directly so store.ts — imported by nearly
// everything — doesn't pull in the command layer's implementation.
export interface CommandBus {
  run<R = unknown>(id: string, args: unknown, origin: CommandOrigin): Promise<R>
  find(query: string): CommandDescriptor[]
  describe(id: string): CommandDescriptor | undefined
}

export interface StoreApi {
  state: AppState
  commands: CommandBus
  // Registry of context blocks contributed by mounted surfaces — see
  // apps/desktop/src/renderer/src/context/useSurfaceContext.ts.
  surfaceContext: SurfaceContextRegistry
  pickRoot(): Promise<void>
  navigateRelative(relativePathFromCurrent: string): Promise<void>
  // Reads a workspace file relative to the currently open document without
  // navigating — ReadView's inline collapsible-snippet preview.
  readSnippet(target: string): Promise<string | null>
  navigateAbsolute(relativeToRoot: string, pushBreadcrumb: boolean): Promise<void>
  inspectFile(relativeToRoot: string): Promise<void>
  // Opens a file's raw source in the in-app read-only code view, optionally
  // scrolled to and highlighting a line range.
  openSourceCode(relativeToRoot: string, range: LineRange | null): Promise<void>
  popTo(index: number): Promise<void>
  // Browser-style single-step history navigation.
  goBack(): Promise<void>
  goForward(): Promise<void>
  toast(message: string, kind?: 'info' | 'error'): void
  reload(): Promise<void>
  runScript(entry: RunEntry): Promise<void>
  killScript(): Promise<void>
  showOutput(): void
  hideOutput(): void
  // Switch the main workspace surface while preserving the selected file.
  setWorkspaceView(view: WorkspaceView): void
  openCurrentFileInEditor(): Promise<void>
  createCurrentExplanation(): Promise<void>
  // Toggle side panel visibility (collapsed ↔ last-active-section).
  toggleSidebar(): void
  refreshTree(): Promise<void>
  sendChat(text: string): Promise<void>
  setActiveSection(section: Section | null): void
  toggleActiveSection(section: Section): void
  setSidePanelWidth(width: number): void
  setActivityOrder(order: Section[]): void
  setCurrentSkill(
    skill: {
      kind?: 'skill' | 'agents'
      scope: 'global' | 'workspace' | 'builtin'
      name: string
      linkTarget?: string
      file?: string
    } | null
  ): void
  setToolsTab(tab: ToolsTab): void
  answerQuestion(requestID: string, answers: string[][]): Promise<void>
  rejectQuestion(requestID: string): Promise<void>
  toggleChatSettings(): void
  fetchProviderMethods(): Promise<Record<string, Array<{ type: 'oauth' | 'api'; label: string }>>>
  configureProvider(provider: string, apiKey: string): Promise<void>
  // Pins new chat sends (any tab) to this provider/model. Doesn't touch
  // credentials — only ever offers providers already in availableProviders.
  selectModel(model: SelectedModel | null): void
  // Toggles a path in/out of coverageIgnore, persisting to
  // .codeswim/coverage-ignore.json.
  toggleCoverageIgnore(path: string): Promise<void>
  newSession(): Promise<void>
  switchSession(sessionId: string): Promise<void>
  refreshSessions(): Promise<void>
  newProject(): Promise<void>
  // Copies the bundled example workspace into userData (first use) and opens it.
  openDemo(): Promise<void>
  openRecent(path: string): Promise<void>
  clearRecents(): Promise<void>
  // Audits the workspace against the MDD rules and either reports clean
  // (toast) or hands the drift report to the agent as a chat prompt.
  syncDiagrams(): Promise<void>
  // Asks the agent to reconstruct the prompt that would regenerate the
  // staged diff, for use as the commit message (subject + body spec).
  synthesizeCommitMessage(diff: string): Promise<CommitMessage>
  // The Sync triage: hands the whole working diff to the agent and gets back a
  // plain-language plan (how to group commits, what to ignore, whether it's
  // safe to auto-commit). Pure inspection — leaves the index untouched.
  planSync(diff: string, changedPaths: string[], instruction?: string): Promise<SyncPlan>
  // Commits exactly the given paths as one isolated commit (subject + body),
  // returning the new sha. Sequential calls build up a multi-commit sync.
  // `dir` targets a Kanban card worktree instead of the workspace root.
  commitGroup(paths: string[], subject: string, body: string, dir?: string): Promise<string>
  // Appends patterns to .gitignore and stops tracking anything already tracked.
  // `dir` targets a Kanban card worktree instead of the workspace root.
  addToGitignore(patterns: string[], dir?: string): Promise<GitIgnoreResult>
  // Loads a single file's working-tree diff and shows it in the main panel.
  // `dir` targets a Kanban card worktree instead of the workspace root.
  showFileDiff(path: string, dir?: string): Promise<void>
  // Closes the main-panel diff viewer, returning to the previous view.
  hideDiff(): void
  // Opens the agent panel and asks it to review the given pull request,
  // handing it the PR's diff so it can inspect the changes.
  reviewPullRequest(pr: PullRequest): Promise<void>
  // Loads a pull request's full diff and shows it in the main panel.
  showPullRequestDiff(pr: PullRequest): Promise<void>
  // Re-fetches the open-PR count behind the Pull requests activity-bar badge.
  // Called after a merge so the badge updates without reopening the workspace.
  refreshOpenPrCount(): Promise<void>
  // Agents view (browser-style tabs, one opencode session per tab).
  // Returns the new tab's id. `directory` scopes the session to a git
  // worktree instead of rootPath (used by Kanban "Run all"); `title`
  // overrides the default "Agent N" placeholder.
  openAgentTab(opts?: { directory?: string; title?: string }): string
  closeAgentTab(tabId: string): void
  activateAgentTab(tabId: string): void
  sendAgentChat(tabId: string, text: string): Promise<void>
  // Kanban "Start" button: opens a new agent tab, switches to the Agents
  // view, and sends the card as the first prompt.
  startAgentFromCard(card: KanbanCard): void
  // Kanban "Run all": same as startAgentFromCard but runs in an isolated git
  // worktree and does NOT switch the workspace view — the point is to keep
  // working while it runs in the background. Returns once the agent's first
  // reply has landed (or errored), so a caller can sequence dependent cards.
  startAgentInWorktree(card: KanbanCard, directory: string): Promise<void>
  // Cards currently mid-flight via kanban.runCard/runColumn (either the
  // "Start in background" button or "Run all"), for disabling per-card start
  // buttons and showing a running indicator. Backed by commands/kanban.ts's
  // KanbanRunTracker so the UI reflects cards auto-launched by "Run all" as
  // dependencies clear, not just ones the component itself triggered.
  kanbanRunningCardIds: ReadonlySet<string>
  // Thin wrappers over commands/kanban.ts (see CommandBus above) — kept on
  // StoreApi rather than making KanbanView call commands.run directly, same
  // as every nav.* command.
  kanbanLoad(root: string): Promise<KanbanBoard | null>
  kanbanSave(board: KanbanBoard): Promise<KanbanBoard | null>
  kanbanGitHubSync(board: KanbanBoard): Promise<KanbanBoard | null>
  kanbanMoveCard(
    board: KanbanBoard,
    cardId: string,
    columnId: string,
    beforeCardId?: string
  ): Promise<KanbanBoard | null>
  kanbanEnsureRepo(): Promise<boolean>
  kanbanRunCard(cardId: string, sourceColumnId: string): Promise<void>
  kanbanRunColumn(columnId: string): Promise<void>
  kanbanListWorktrees(root: string): Promise<KanbanWorktreeInfo[]>
  // Thin wrappers over commands/git.ts, same pattern as the kanban.* ones
  // above.
  gitRefreshStatus(dir: string): Promise<GitStatus>
  gitLoadHistory(dir: string, limit: number): Promise<GitCommitEntry[]>
  gitInitRepo(root: string): Promise<GitInitResult>
  gitSync(dir: string, isCardTarget: boolean, instruction?: string): Promise<GitSyncOutcome>
  gitCommitPlan(
    dir: string,
    plan: SyncPlan
  ): Promise<{ commits: Array<{ subject: string; sha: string }>; sync: GitSyncResult }>
  // Thin wrappers over commands/skills.ts, same pattern as the kanban.*/
  // git.* ones above.
  skillsList(root: string | null): Promise<SkillListResult>
  skillsListFiles(scope: SkillScope, name: string, root: string | null): Promise<SkillFileNode[]>
  skillsReadFile(
    scope: SkillScope,
    name: string,
    path: string,
    root: string | null
  ): Promise<SkillFileContent>
  skillsWriteFile(
    scope: SkillScope,
    name: string,
    path: string,
    content: string,
    root: string | null
  ): Promise<void>
  skillsReadAgentsDoc(scope: AgentsScope, root: string | null): Promise<AgentsDocContent>
  skillsWriteAgentsDoc(scope: AgentsScope, content: string, root: string | null): Promise<void>
  skillsCreate(
    scope: 'global' | 'workspace',
    name: string,
    template: string,
    root: string | null
  ): Promise<void>
  skillsDelete(
    scope: SkillScope,
    name: string,
    linkTarget: string | undefined,
    root: string | null
  ): Promise<void>
  skillsLinkFolder(
    scope: 'global' | 'workspace',
    source: string,
    root: string | null
  ): Promise<LinkFolderResult>
  skillsOpenInEditor(
    scope: SkillScope,
    name: string,
    root: string | null,
    path?: string
  ): Promise<void>
  skillsOpenAgentsDocInEditor(scope: AgentsScope, root: string | null): Promise<void>
  hooksRead(root: string | null): Promise<AgentsDocContent>
  hooksWrite(root: string | null, content: string): Promise<void>
  hooksOpenInEditor(root: string | null): Promise<void>
  // Thin wrappers over commands/github.ts, same pattern as the kanban.*/
  // git.*/skills.* ones above.
  githubRoomIdentity(root: string): Promise<RoomIdentity | null>
  githubAuthStatus(): Promise<GitHubStatus>
  githubAccessToken(): Promise<string | null>
  githubSignIn(): Promise<GitHubSignInResult | { error: string }>
  githubSignOut(): Promise<void>
  githubListPullRequests(root: string, filter?: 'open' | 'closed' | 'all'): Promise<PullRequestList>
  githubMergePullRequest(root: string, number: number, method?: MergeMethod): Promise<MergeResult>
}

export const StoreContext = createContext<StoreApi | null>(null)

export function useStore(): StoreApi {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore must be used within StoreProvider')
  return ctx
}
