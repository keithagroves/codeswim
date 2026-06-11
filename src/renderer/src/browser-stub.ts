// When the renderer runs outside Electron (e.g. http://localhost:5173 in a
// regular browser for Playwright/UI review), `window.api` is undefined and
// every `useEffect` that subscribes to it crashes the app. This installs a
// minimal no-op stub so the UI still renders for inspection.
//
// All Electron-only side effects (folder pick, file watcher, harness spawn)
// fail with a friendly error; everything that just reads state works.

import type { DiagramNavApi, HarnessConnection, NewProjectResult, TreeNode } from '../../preload/index.d'

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
    readFile: async (absPath: string) => {
      const cfg = readTestConfig()
      if (!cfg.harnessUrl || !cfg.rootPath) {
        throw new Error('readFile is only available inside the Electron app')
      }
      // Convert absolute path back to workspace-relative for opencode.
      const root = cfg.rootPath.replace(/\/$/, '')
      const rel = absPath.startsWith(root + '/') ? absPath.slice(root.length + 1) : absPath
      const url = new URL('/file/content', cfg.harnessUrl)
      url.searchParams.set('directory', cfg.rootPath)
      url.searchParams.set('path', rel)
      const res = await fetch(url.toString())
      if (!res.ok) throw new Error(`readFile via opencode: ${res.status} ${res.statusText}`)
      const data = (await res.json()) as { type: string; content: string }
      return data.content
    },
    listMarkdown: async () => {
      const cfg = readTestConfig()
      if (!cfg.harnessUrl || !cfg.rootPath) return []
      try {
        const url = new URL('/find/file', cfg.harnessUrl)
        url.searchParams.set('directory', cfg.rootPath)
        url.searchParams.set('query', 'md')
        const res = await fetch(url.toString())
        if (!res.ok) return []
        const data = (await res.json()) as string[]
        return data
          .filter((p) => /\.md$/i.test(p) && !p.includes('node_modules/'))
          .map((p) => `${cfg.rootPath}/${p}`)
      } catch {
        return []
      }
    },
    listTree: async () => {
      const cfg = readTestConfig()
      if (!cfg.harnessUrl || !cfg.rootPath) return []
      try {
        const url = new URL('/find/file', cfg.harnessUrl)
        url.searchParams.set('directory', cfg.rootPath)
        // opencode returns directories for an empty query; use '.' to get
        // a comprehensive file list (matches any path containing a dot).
        url.searchParams.set('query', '.')
        const res = await fetch(url.toString())
        if (!res.ok) return []
        const paths = (await res.json()) as string[]
        // Build a nested tree from the flat path list, skipping node_modules.
        type DirAccumulator = {
          [name: string]: { kind: 'file' | 'dir'; children?: DirAccumulator }
        }
        const root: DirAccumulator = {}
        for (const p of paths) {
          if (p.includes('node_modules/') || p.startsWith('node_modules/')) continue
          const parts = p.split('/').filter(Boolean)
          let cursor = root
          for (let i = 0; i < parts.length; i++) {
            const name = parts[i]!
            const isLeaf = i === parts.length - 1
            if (isLeaf) {
              cursor[name] = { kind: 'file' }
            } else {
              if (!cursor[name]) cursor[name] = { kind: 'dir', children: {} }
              cursor = cursor[name].children!
            }
          }
        }
        const materialize = (acc: DirAccumulator, prefix: string): TreeNode[] => {
          const out: TreeNode[] = []
          for (const [name, entry] of Object.entries(acc)) {
            const path = prefix ? `${prefix}/${name}` : name
            if (entry.kind === 'file') {
              out.push({ kind: 'file', name, path })
            } else {
              out.push({
                kind: 'dir',
                name,
                path,
                children: materialize(entry.children ?? {}, path)
              })
            }
          }
          out.sort((a, b) => {
            if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
            return a.name.localeCompare(b.name)
          })
          return out
        }
        return materialize(root, '')
      } catch {
        return []
      }
    },
    watch: () => Promise.resolve(),
    unwatch: () => Promise.resolve(),
    onFileChanged: noopUnsub,
    onTreeChanged: noopUnsub,
    listRuns: async () => {
      const cfg = readTestConfig()
      if (!cfg.harnessUrl || !cfg.rootPath) return []
      const fetchText = async (rel: string): Promise<string | null> => {
        try {
          const url = new URL('/file/content', cfg.harnessUrl!)
          url.searchParams.set('directory', cfg.rootPath!)
          url.searchParams.set('path', rel)
          const res = await fetch(url.toString())
          if (!res.ok) return null
          const data = (await res.json()) as { type: string; content: string }
          return data.content
        } catch {
          return null
        }
      }
      const out: Array<{
        source: 'npm' | 'custom'
        name: string
        command: string
        description?: string
      }> = []
      const customRaw = await fetchText('.codeswim/runs.json')
      if (customRaw) {
        try {
          const parsed = JSON.parse(customRaw)
          if (Array.isArray(parsed)) {
            for (const entry of parsed) {
              if (!entry || typeof entry !== 'object') continue
              const e = entry as Record<string, unknown>
              if (typeof e.name !== 'string' || typeof e.command !== 'string') continue
              out.push({
                source: 'custom',
                name: e.name,
                command: e.command,
                description: typeof e.description === 'string' ? e.description : undefined
              })
            }
          }
        } catch {
          // ignore
        }
      }
      const pkgRaw = await fetchText('package.json')
      if (pkgRaw) {
        try {
          const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> }
          for (const name of Object.keys(pkg.scripts ?? {}).sort()) {
            out.push({ source: 'npm', name, command: `npm run ${name}` })
          }
        } catch {
          // ignore
        }
      }
      return out
    },
    runEntry: notInBrowser<void>('runEntry'),
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
    onMenuRecentsCleared: noopUnsub,
    listSkills: async () => ({ builtin: [], global: [], workspace: [] }),
    readSkill: notInBrowser<string>('readSkill'),
    writeSkill: notInBrowser<void>('writeSkill'),
    deleteSkill: notInBrowser<void>('deleteSkill'),
    pickSkillLinkSource: async () => null,
    linkSkillFolder: async () => ({ linked: [], skipped: [] }),
    openSkillInEditor: notInBrowser<void>('openSkillInEditor'),
    listSkillFiles: async () => [],
    readSkillFile: async () => ({ binary: false, content: '', size: 0 }),
    writeSkillFile: notInBrowser<void>('writeSkillFile'),
    gitStatus: async () => ({
      isRepo: true,
      branch: null,
      staged: [],
      unstaged: [],
      untracked: [],
      clean: true
    }),
    gitStagedDiff: async () => '',
    gitCommit: notInBrowser<string>('gitCommit'),
    gitInit: notInBrowser<{ createdGitignore: boolean }>('gitInit'),
    gitStageAll: notInBrowser<void>('gitStageAll'),
    gitUnstageAll: notInBrowser<void>('gitUnstageAll'),
    gitLog: async () => [],
    terminalCreate: notInBrowser<string>('terminalCreate'),
    terminalWrite: () => {},
    terminalResize: () => {},
    terminalDestroy: () => {},
    onTerminalData: () => () => {},
    onTerminalExit: () => () => {}
  }

  ;(window as unknown as { api: DiagramNavApi }).api = stub
}
