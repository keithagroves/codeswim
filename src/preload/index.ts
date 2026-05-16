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
  readPackageScripts: (rootPath: string): Promise<string[]> =>
    ipcRenderer.invoke('read-package-scripts', rootPath),
  runScript: (rootPath: string, name: string): Promise<void> =>
    ipcRenderer.invoke('run-script', rootPath, name),
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
  }
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
