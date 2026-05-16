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

export interface DiagramNavApi {
  pickFolder(): Promise<string | null>
  readFile(absPath: string): Promise<string>
  listMarkdown(rootPath: string): Promise<string[]>
  listTree(rootPath: string): Promise<TreeNode[]>
  watch(rootPath: string): Promise<void>
  unwatch(): Promise<void>
  onFileChanged(cb: (absPath: string) => void): () => void
  onTreeChanged(cb: () => void): () => void
  readPackageScripts(rootPath: string): Promise<string[]>
  runScript(rootPath: string, name: string): Promise<void>
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
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: DiagramNavApi
  }
}
