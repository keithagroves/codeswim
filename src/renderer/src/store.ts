import { createContext, useContext } from 'react'
import type { PendingQuestion } from './agent'
import type { CommitMessage } from './commit/synthesize'
import type { SyncPlan } from './commit/triage'
import type { GitIgnoreResult } from '../../preload/index.d'

export type { PendingQuestion } from './agent'
export type { CommitMessage } from './commit/synthesize'

export type View = 'diagram' | 'read' | 'output'
export type FileView = 'diagram' | 'read'
export type WorkspaceView = 'kanban' | 'navigator'
// Activity-bar / side-panel sections, in no particular order. The user's
// preferred order lives in AppState.activityOrder.
export type Section = 'agent' | 'files' | 'search' | 'skills' | 'git' | 'terminal' | 'chat'

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

export interface AppState {
  rootPath: string | null
  workspaceView: WorkspaceView
  currentFile: string | null
  // Markdown document currently rendered for currentFile. For source
  // leaves this is the companion explanation path.
  currentDocumentPath: string | null
  sourceExplanationExists: boolean
  breadcrumbs: string[]
  view: View
  fileContents: string | null
  loading: boolean
  toasts: Toast[]
  runs: RunEntry[]
  runningScript: RunningScript | null
  // The view we should return to when the user closes the output panel.
  prevView: FileView | null
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
  // Selected skill in the Skills view (null = nothing picked yet).
  // linkTarget is set when the skill directory is a symlink, so the view
  // can show where it came from and adjust delete messaging. `file` is the
  // POSIX-relative path of the file currently being viewed inside the
  // skill — defaults to SKILL.md when omitted.
  currentSkill: {
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
}

export interface StoreApi {
  state: AppState
  pickRoot(): Promise<void>
  navigateRelative(relativePathFromCurrent: string): Promise<void>
  navigateAbsolute(relativeToRoot: string, pushBreadcrumb: boolean): Promise<void>
  inspectFile(relativeToRoot: string): Promise<void>
  popTo(index: number): Promise<void>
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
      scope: 'global' | 'workspace' | 'builtin'
      name: string
      linkTarget?: string
      file?: string
    } | null
  ): void
  answerQuestion(requestID: string, answers: string[][]): Promise<void>
  rejectQuestion(requestID: string): Promise<void>
  toggleChatSettings(): void
  fetchProviderMethods(): Promise<Record<string, Array<{ type: 'oauth' | 'api'; label: string }>>>
  configureProvider(provider: string, apiKey: string): Promise<void>
  newSession(): Promise<void>
  switchSession(sessionId: string): Promise<void>
  refreshSessions(): Promise<void>
  newProject(): Promise<void>
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
  commitGroup(paths: string[], subject: string, body: string): Promise<string>
  // Appends patterns to .gitignore and stops tracking anything already tracked.
  addToGitignore(patterns: string[]): Promise<GitIgnoreResult>
}

export const StoreContext = createContext<StoreApi | null>(null)

export function useStore(): StoreApi {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore must be used within StoreProvider')
  return ctx
}
