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
  kind: 'text' | 'tool' | 'unknown'
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
  scripts: string[]
  runningScript: RunningScript | null
  // The view we should return to when the user closes the output panel.
  prevView: FileView | null
  tree: TreeNode[] | null
  sidebarOpen: boolean
  chatStatus: ChatStatus
  chatError: string | null
  chatMessages: ChatMessage[]
  chatPanelOpen: boolean
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
  runScript(name: string): Promise<void>
  killScript(): Promise<void>
  showOutput(): void
  hideOutput(): void
  toggleSidebar(): void
  // For markdown files: switch between rendered diagram and raw source view.
  toggleSource(): void
  // Switch directly to one of the file-level views (read/diagram/code).
  setView(view: FileView): void
  refreshTree(): Promise<void>
  sendChat(text: string): Promise<void>
  toggleChatPanel(): void
  toggleChatSettings(): void
  fetchProviderMethods(): Promise<Record<string, Array<{ type: 'oauth' | 'api'; label: string }>>>
  configureProvider(provider: string, apiKey: string): Promise<void>
  newSession(): Promise<void>
  switchSession(sessionId: string): Promise<void>
  refreshSessions(): Promise<void>
  newProject(): Promise<void>
  openRecent(path: string): Promise<void>
  clearRecents(): Promise<void>
}

export const StoreContext = createContext<StoreApi | null>(null)

export function useStore(): StoreApi {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore must be used within StoreProvider')
  return ctx
}
