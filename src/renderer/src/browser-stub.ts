// When the renderer runs outside Electron (e.g. http://localhost:5173 in a
// regular browser for Playwright/UI review), `window.api` is undefined and
// every `useEffect` that subscribes to it crashes the app. This installs a
// minimal no-op stub so the UI still renders for inspection.
//
// All Electron-only side effects (folder pick, file watcher, harness spawn)
// fail with a friendly error; everything that just reads state works.

import type { DiagramNavApi, HarnessConnection, NewProjectResult } from '../../preload/index.d'

function notInBrowser<T>(name: string): () => Promise<T> {
  return () => Promise.reject(new Error(`${name} is only available inside the Electron app`))
}

function noopUnsub(): () => void {
  return () => {}
}

// When running standalone in a browser, you can preconfigure these in
// localStorage to drive the agent against a separately-spawned opencode:
//   localStorage.setItem('codeswim:test:rootPath', '/abs/path/to/workspace')
//   localStorage.setItem('codeswim:test:harnessUrl', 'http://127.0.0.1:4096')
// Then `pickFolder` returns the configured path and `startHarness` returns
// the configured URL, so the chat panel can talk to a real agent from the
// browser without Electron.
function readTestConfig(): { rootPath: string | null; harnessUrl: string | null } {
  try {
    return {
      rootPath: localStorage.getItem('codeswim:test:rootPath'),
      harnessUrl: localStorage.getItem('codeswim:test:harnessUrl')
    }
  } catch {
    return { rootPath: null, harnessUrl: null }
  }
}

export function installBrowserApiStub(): void {
  if (typeof window === 'undefined') return
  if ('api' in window && window.api) return

  const stub: DiagramNavApi = {
    pickFolder: async () => readTestConfig().rootPath,
    readFile: notInBrowser<string>('readFile'),
    listMarkdown: () => Promise.resolve([]),
    listTree: () => Promise.resolve([]),
    watch: () => Promise.resolve(),
    unwatch: () => Promise.resolve(),
    onFileChanged: noopUnsub,
    onTreeChanged: noopUnsub,
    readPackageScripts: () => Promise.resolve([]),
    runScript: notInBrowser<void>('runScript'),
    killScript: () => Promise.resolve(),
    onScriptOutput: noopUnsub,
    onScriptExit: noopUnsub,
    startHarness: async () => {
      const cfg = readTestConfig()
      if (!cfg.harnessUrl) {
        throw new Error(
          'startHarness is only available inside the Electron app (or set localStorage.codeswim:test:harnessUrl to talk to a manually-spawned opencode)'
        )
      }
      return { url: cfg.harnessUrl } as HarnessConnection
    },
    stopHarness: () => Promise.resolve(),
    onHarnessLog: noopUnsub,
    onHarnessExit: noopUnsub,
    onMenuOpenFolder: noopUnsub,
    newProject: notInBrowser<NewProjectResult | null>('newProject'),
    getRecents: () => Promise.resolve([]),
    clearRecents: () => Promise.resolve([]),
    addRecent: () => Promise.resolve([]),
    onMenuNewProject: noopUnsub,
    onMenuOpenRecent: noopUnsub,
    onMenuRecentsCleared: noopUnsub
  }

  ;(window as unknown as { api: DiagramNavApi }).api = stub
}
