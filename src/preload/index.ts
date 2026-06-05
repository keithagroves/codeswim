import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

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

const api = {
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('pick-folder'),
  readFile: (absPath: string): Promise<string> => ipcRenderer.invoke('read-file', absPath),
  listMarkdown: (rootPath: string): Promise<string[]> =>
    ipcRenderer.invoke('list-markdown', rootPath),
  listTree: (rootPath: string): Promise<TreeNode[]> => ipcRenderer.invoke('list-tree', rootPath),
  watch: (rootPath: string): Promise<void> => ipcRenderer.invoke('watch', rootPath),
  unwatch: (): Promise<void> => ipcRenderer.invoke('unwatch'),
  onFileChanged: (cb: (absPath: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, absPath: string): void => cb(absPath)
    ipcRenderer.on('file-changed', listener)
    return () => ipcRenderer.removeListener('file-changed', listener)
  },
  onTreeChanged: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('tree-changed', listener)
    return () => ipcRenderer.removeListener('tree-changed', listener)
  },
  listRuns: (rootPath: string): Promise<RunEntry[]> => ipcRenderer.invoke('list-runs', rootPath),
  runEntry: (rootPath: string, source: 'npm' | 'custom', name: string): Promise<void> =>
    ipcRenderer.invoke('run-entry', rootPath, source, name),
  killScript: (): Promise<void> => ipcRenderer.invoke('kill-script'),
  onScriptOutput: (cb: (payload: ScriptOutputPayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ScriptOutputPayload): void =>
      cb(payload)
    ipcRenderer.on('script-output', listener)
    return () => ipcRenderer.removeListener('script-output', listener)
  },
  onScriptExit: (cb: (payload: ScriptExitPayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ScriptExitPayload): void =>
      cb(payload)
    ipcRenderer.on('script-exit', listener)
    return () => ipcRenderer.removeListener('script-exit', listener)
  },
  startHarness: (rootPath: string): Promise<HarnessConnection> =>
    ipcRenderer.invoke('harness:start', rootPath),
  stopHarness: (): Promise<void> => ipcRenderer.invoke('harness:stop'),
  onHarnessLog: (cb: (payload: HarnessLogPayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: HarnessLogPayload): void =>
      cb(payload)
    ipcRenderer.on('harness:log', listener)
    return () => ipcRenderer.removeListener('harness:log', listener)
  },
  onHarnessExit: (cb: (payload: HarnessExitPayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: HarnessExitPayload): void =>
      cb(payload)
    ipcRenderer.on('harness:exit', listener)
    return () => ipcRenderer.removeListener('harness:exit', listener)
  },
  onMenuOpenFolder: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('menu:open-folder', listener)
    return () => ipcRenderer.removeListener('menu:open-folder', listener)
  },
  newProject: (): Promise<NewProjectResult | null> => ipcRenderer.invoke('new-project'),
  getRecents: (): Promise<string[]> => ipcRenderer.invoke('get-recents'),
  clearRecents: (): Promise<string[]> => ipcRenderer.invoke('clear-recents'),
  addRecent: (path: string): Promise<string[]> => ipcRenderer.invoke('add-recent', path),
  onMenuNewProject: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('menu:new-project', listener)
    return () => ipcRenderer.removeListener('menu:new-project', listener)
  },
  onMenuOpenRecent: (cb: (path: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, path: string): void => cb(path)
    ipcRenderer.on('menu:open-recent', listener)
    return () => ipcRenderer.removeListener('menu:open-recent', listener)
  },
  onMenuRecentsCleared: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('menu:recents-cleared', listener)
    return () => ipcRenderer.removeListener('menu:recents-cleared', listener)
  },
  listSkills: (rootPath: string | null): Promise<SkillListResult> =>
    ipcRenderer.invoke('skills:list', rootPath),
  readSkill: (scope: SkillScope, name: string, rootPath: string | null): Promise<string> =>
    ipcRenderer.invoke('skills:read', scope, name, rootPath),
  writeSkill: (
    scope: SkillScope,
    name: string,
    content: string,
    rootPath: string | null
  ): Promise<void> => ipcRenderer.invoke('skills:write', scope, name, content, rootPath),
  deleteSkill: (scope: SkillScope, name: string, rootPath: string | null): Promise<void> =>
    ipcRenderer.invoke('skills:delete', scope, name, rootPath),
  pickSkillLinkSource: (): Promise<string | null> => ipcRenderer.invoke('skills:pick-link-source'),
  linkSkillFolder: (
    scope: 'global' | 'workspace',
    sourcePath: string,
    rootPath: string | null
  ): Promise<LinkFolderResult> =>
    ipcRenderer.invoke('skills:link-folder', scope, sourcePath, rootPath),
  openSkillInEditor: (
    scope: SkillScope,
    name: string,
    rootPath: string | null,
    relPath?: string
  ): Promise<void> => ipcRenderer.invoke('skills:open-in-editor', scope, name, rootPath, relPath),
  listSkillFiles: (
    scope: SkillScope,
    name: string,
    rootPath: string | null
  ): Promise<SkillFileNode[]> => ipcRenderer.invoke('skills:list-files', scope, name, rootPath),
  readSkillFile: (
    scope: SkillScope,
    name: string,
    relPath: string,
    rootPath: string | null
  ): Promise<SkillFileContent> =>
    ipcRenderer.invoke('skills:read-file', scope, name, relPath, rootPath),
  writeSkillFile: (
    scope: SkillScope,
    name: string,
    relPath: string,
    content: string,
    rootPath: string | null
  ): Promise<void> =>
    ipcRenderer.invoke('skills:write-file', scope, name, relPath, content, rootPath),
  gitStatus: (rootPath: string): Promise<GitStatus> => ipcRenderer.invoke('git:status', rootPath),
  gitStagedDiff: (rootPath: string): Promise<string> =>
    ipcRenderer.invoke('git:staged-diff', rootPath),
  gitCommit: (rootPath: string, subject: string, body: string): Promise<string> =>
    ipcRenderer.invoke('git:commit', rootPath, subject, body),
  gitInit: (rootPath: string): Promise<GitInitResult> => ipcRenderer.invoke('git:init', rootPath),
  gitStageAll: (rootPath: string): Promise<void> => ipcRenderer.invoke('git:stage-all', rootPath)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
