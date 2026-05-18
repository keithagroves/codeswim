import { createContext, useContext } from 'react'
import type { LineRange } from './path-utils'

export type { LineRange } from './path-utils'

export type View = 'diagram' | 'code' | 'read' | 'output'
export type FileView = 'diagram' | 'code' | 'read'

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
  currentFile: string | null
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
  activeSection: 'files' | 'agent' | 'search' | null
  // Remembers which section was last open so toggling the panel closed
  // and back open restores it (rather than always returning to 'files').
  lastActiveSection: 'files' | 'agent' | 'search'
  // Side panel width in pixels. Persisted to localStorage so it survives
  // reloads.
  sidePanelWidth: number
  // User-controlled order of activity-bar sections (drag-to-reorder).
  // Persisted to localStorage.
  activityOrder: Array<'agent' | 'files' | 'search'>
  chatStatus: ChatStatus
  chatError: string | null
  chatMessages: ChatMessage[]
  chatSettingsOpen: boolean
  sessions: SessionInfo[]
  currentSessionId: string | null
  recents: string[]
  // Highlight range when navigating to a source file with a #L10-L22 ref;
  // null otherwise. Reset on workspace change.
  currentRange: LineRange | null
}

export interface StoreApi {
  state: AppState
  pickRoot(): Promise<void>
  navigateRelative(relativePathFromCurrent: string): Promise<void>
  navigateAbsolute(relativeToRoot: string, pushBreadcrumb: boolean): Promise<void>
  popTo(index: number): Promise<void>
  toast(message: string, kind?: 'info' | 'error'): void
  reload(): Promise<void>
  runScript(entry: RunEntry): Promise<void>
  killScript(): Promise<void>
  showOutput(): void
  hideOutput(): void
  // For markdown files: switch between rendered diagram and raw source view.
  toggleSource(): void
  // Switch directly to one of the file-level views (read/diagram/code).
  setView(view: FileView): void
  // Toggle side panel visibility (collapsed ↔ last-active-section).
  toggleSidebar(): void
  refreshTree(): Promise<void>
  sendChat(text: string): Promise<void>
  setActiveSection(section: 'files' | 'agent' | 'search' | null): void
  toggleActiveSection(section: 'files' | 'agent' | 'search'): void
  setSidePanelWidth(width: number): void
  setActivityOrder(order: Array<'agent' | 'files' | 'search'>): void
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
}

export const StoreContext = createContext<StoreApi | null>(null)

export function useStore(): StoreApi {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore must be used within StoreProvider')
  return ctx
}
