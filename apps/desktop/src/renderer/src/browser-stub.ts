// When the renderer runs outside Electron (e.g. http://localhost:5173 in a
// regular browser for Playwright/UI review), `window.api` is undefined and
// every `useEffect` that subscribes to it crashes the app. This installs a
// minimal no-op stub so the UI still renders for inspection.
//
// All Electron-only side effects (folder pick, file watcher, harness spawn)
// fail with a friendly error; everything that just reads state works.

import type {
  DiagramNavApi,
  HarnessConnection,
  NewProjectResult,
  SourceExplanation,
  TreeNode
} from '@codeswim/contract'
import {
  createDefaultKanbanBoard,
  normalizeKanbanBoard,
  type KanbanBoard
} from '@codeswim/contract'

function notInBrowser<T>(name: string): () => Promise<T> {
  return () => Promise.reject(new Error(`${name} is only available inside the Electron app`))
}

function noopUnsub(): () => void {
  return () => {}
}

function browserFixtureOverview(): string {
  return `---
name: Browser fixture
description: Source explanation review
tags: [browser, fixture]
---

\`\`\`mermaid
flowchart LR
  Login["login.ts"]
  Missing["missing.ts"]
  click Login call navigate("./src/auth/login.ts")
  click Missing call navigate("./src/auth/missing.ts")
\`\`\`

Open either source leaf to review its companion documentation.
`
}

function browserFixtureExplanation(sourcePath: string): SourceExplanation | null {
  if (sourcePath !== 'src/auth/login.ts') return null
  return {
    sourcePath,
    documentPath: `.codeswim/explanations/${sourcePath}.md`,
    exists: true,
    content: `---
name: Login handler
description: Authenticates a user and establishes an application session.
tags: [auth, source, explanation]
---

## Purpose

Validates login credentials and creates the authenticated session used by later requests.

## Flow

1. Validate the submitted email and password.
2. Load the matching user record.
3. Compare the password against the stored credential.
4. Return the signed session token.

## Failure modes

- Invalid credentials produce an authentication error without identifying which field failed.
- Disabled accounts are rejected before a session is created.

## Related docs

- [Architecture overview](../../../../overview.md)
`
  }
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
    const params = new URLSearchParams(window.location.search)
    return {
      rootPath: localStorage.getItem('codeswim:test:rootPath') ?? params.get('workspace'),
      harnessUrl: localStorage.getItem('codeswim:test:harnessUrl') ?? params.get('harness')
    }
  } catch {
    return { rootPath: null, harnessUrl: null }
  }
}

export function installBrowserApiStub(): void {
  if (typeof window === 'undefined') return
  if ('api' in window && window.api) return

  let browserBoard = createDefaultKanbanBoard('Browser board')
  const stub: DiagramNavApi = {
    pickFolder: async () => readTestConfig().rootPath,
    readFile: async (absPath: string) => {
      const cfg = readTestConfig()
      if (cfg.rootPath && !cfg.harnessUrl && absPath === `${cfg.rootPath}/overview.md`) {
        return browserFixtureOverview()
      }
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
    readSourceExplanation: async (
      _rootPath: string,
      sourcePath: string
    ): Promise<SourceExplanation> => {
      const fixture = browserFixtureExplanation(sourcePath)
      if (fixture) return fixture
      const documentPath = `.codeswim/explanations/${sourcePath}.md`
      return {
        sourcePath,
        documentPath,
        exists: false,
        content: `---
name: ${JSON.stringify(sourcePath.split('/').pop() ?? sourcePath)}
description: ${JSON.stringify(`Explanation for ${sourcePath}`)}
tags: [source, explanation, missing]
---

\`${sourcePath}\` is an implementation leaf. Codeswim intentionally does not render its source code here.

The companion document belongs at \`${documentPath}\`.
`
      }
    },
    openWorkspaceFile: notInBrowser<void>('Opening files in an editor'),
    listMarkdown: async () => {
      const cfg = readTestConfig()
      if (cfg.rootPath && !cfg.harnessUrl) return [`${cfg.rootPath}/overview.md`]
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
      if (cfg.rootPath && !cfg.harnessUrl) {
        return [
          { kind: 'file', name: 'overview.md', path: 'overview.md' },
          {
            kind: 'dir',
            name: 'src',
            path: 'src',
            children: [
              {
                kind: 'dir',
                name: 'auth',
                path: 'src/auth',
                children: [
                  { kind: 'file', name: 'login.ts', path: 'src/auth/login.ts' },
                  { kind: 'file', name: 'missing.ts', path: 'src/auth/missing.ts' }
                ]
              }
            ]
          }
        ]
      }
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
    kanbanRead: async () => browserBoard,
    kanbanWrite: async (_rootPath: string, board: KanbanBoard) => {
      browserBoard = normalizeKanbanBoard(board, 'Browser board')
      return browserBoard
    },
    kanbanGitHubSync: notInBrowser<KanbanBoard>('GitHub Projects sync'),
    kanbanGitHubMove: notInBrowser<void>('GitHub Projects status updates'),
    kanbanWorktreeCreate: notInBrowser<{ path: string; branch: string }>('Run all (git worktrees)'),
    kanbanWorktreeRemove: notInBrowser<void>('Run all (git worktrees)'),
    kanbanWorktreeList: async () => [],
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
    openDemo: notInBrowser<string>('openDemo'),
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
    agentsDocRead: async () => ({ content: '', exists: false, size: 0 }),
    agentsDocWrite: notInBrowser<void>('agentsDocWrite'),
    agentsDocOpenInEditor: notInBrowser<void>('agentsDocOpenInEditor'),
    gitStatus: async () => ({
      isRepo: true,
      branch: null,
      staged: [],
      unstaged: [],
      untracked: [],
      clean: true
    }),
    gitStagedDiff: async () => '',
    gitWorkingDiff: async () => '',
    gitFileDiff: async () => '',
    gitPush: async () => ({ remote: false, pushed: false, branch: null, conflict: false }),
    gitCommit: notInBrowser<string>('gitCommit'),
    gitCommitGroup: notInBrowser<string>('gitCommitGroup'),
    gitAddToGitignore: notInBrowser<{ added: string[]; untracked: string[] }>('gitAddToGitignore'),
    gitInit: notInBrowser<{ createdGitignore: boolean }>('gitInit'),
    gitStageAll: notInBrowser<void>('gitStageAll'),
    gitUnstageAll: notInBrowser<void>('gitUnstageAll'),
    gitLog: async () => [],
    roomIdentity: async () => null,
    githubStatus: async () => ({ configured: false, user: null }),
    githubSignIn: async () => ({ error: 'GitHub sign-in is unavailable in the browser.' }),
    githubSignOut: async () => {},
    githubToken: async () => null,
    listPullRequests: async () => ({ status: 'not-github' as const, slug: null, pulls: [] }),
    mergePullRequest: async () => ({ status: 'not-github' as const }),
    pullRequestDiff: async () => ({ status: 'not-github' as const, diff: '' }),
    onGitHubAuthChanged: () => () => {},
    terminalCreate: notInBrowser<string>('terminalCreate'),
    terminalWrite: () => {},
    terminalResize: () => {},
    terminalDestroy: () => {},
    onTerminalData: () => () => {},
    onTerminalExit: () => () => {},
    publishAgentState: async () => {},
    agentTabsRead: async () => null,
    agentTabsWrite: async () => {},
    onUpdateStatus: () => () => {},
    installUpdate: async () => {}
  }

  ;(window as unknown as { api: DiagramNavApi }).api = stub
}
