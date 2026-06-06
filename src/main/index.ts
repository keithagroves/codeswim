import { app, shell, BrowserWindow, ipcMain, dialog, Menu, type MenuItemConstructorOptions } from 'electron'
import { join, basename, dirname } from 'path'
import { promises as fs } from 'fs'
import { spawn, ChildProcess } from 'child_process'
import chokidar, { FSWatcher } from 'chokidar'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { startSidecar, type SidecarHandle } from './sidecar'
import {
  deleteSkill,
  linkFolder,
  listSkillFiles,
  listSkills,
  readSkill,
  readSkillFile,
  resolveSkillFilePath,
  writeSkill,
  writeSkillFile,
  type SkillScope
} from './skills'
import {
  gitStatus,
  gitStagedDiff,
  gitCommit,
  gitInit,
  gitStageAll,
  gitUnstageAll,
  gitLog
} from './git'

let mainWindow: BrowserWindow | null = null
let watcher: FSWatcher | null = null
let watchedRoot: string | null = null

interface ScriptRun {
  name: string
  child: ChildProcess
  startedAt: number
}

let activeRun: ScriptRun | null = null
let sidecar: SidecarHandle | null = null
let sidecarRoot: string | null = null
let sidecarStarting: Promise<SidecarHandle> | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function walkMarkdown(dir: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkMarkdown(full, out)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(full)
    }
  }
}

const TREE_IGNORED_DIRS = new Set(['node_modules', 'dist', 'out', 'build', '.git'])
const TREE_IGNORED_FILES = new Set(['.DS_Store'])

interface TreeNode {
  kind: 'file' | 'dir'
  name: string
  path: string // posix, relative to root
  children?: TreeNode[]
}

async function walkTree(rootPath: string, dir: string, relPrefix: string): Promise<TreeNode[]> {
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const nodes: TreeNode[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env' && entry.name !== '.gitignore') continue
    if (entry.isDirectory() && TREE_IGNORED_DIRS.has(entry.name)) continue
    if (entry.isFile() && TREE_IGNORED_FILES.has(entry.name)) continue

    const full = join(dir, entry.name)
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name

    if (entry.isDirectory()) {
      nodes.push({
        kind: 'dir',
        name: entry.name,
        path: rel,
        children: await walkTree(rootPath, full, rel)
      })
    } else if (entry.isFile()) {
      nodes.push({ kind: 'file', name: entry.name, path: rel })
    }
  }

  // Directories first, then files; alphabetical within each group.
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return nodes
}

async function listTree(rootPath: string): Promise<TreeNode[]> {
  return walkTree(rootPath, rootPath, '')
}

function stopWatching(): void {
  if (watcher) {
    watcher.close()
    watcher = null
    watchedRoot = null
  }
}

function startWatching(rootPath: string): void {
  if (watchedRoot === rootPath && watcher) return
  stopWatching()

  watcher = chokidar.watch(rootPath, {
    ignored: (path: string) => {
      const base = path.split('/').pop() ?? ''
      if (
        base.startsWith('.') &&
        base !== '.env' &&
        base !== '.gitignore' &&
        base !== '.codeswim' &&
        base !== '.'
      ) {
        return true
      }
      if (TREE_IGNORED_DIRS.has(base) || TREE_IGNORED_FILES.has(base)) return true
      return false
    },
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }
  })
  watchedRoot = rootPath

  let treeChangeTimer: NodeJS.Timeout | null = null
  const scheduleTreeChange = (): void => {
    if (treeChangeTimer) clearTimeout(treeChangeTimer)
    treeChangeTimer = setTimeout(() => {
      treeChangeTimer = null
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send('tree-changed')
    }, 200)
  }

  const onChange = (absPath: string): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    // Tell the renderer the contents changed, regardless of extension —
    // the renderer reloads only if it's currently displayed.
    mainWindow.webContents.send('file-changed', absPath)
  }

  const onAddOrUnlink = (absPath: string): void => {
    onChange(absPath)
    scheduleTreeChange()
  }

  watcher.on('change', onChange)
  watcher.on('add', onAddOrUnlink)
  watcher.on('unlink', onAddOrUnlink)
  watcher.on('addDir', scheduleTreeChange)
  watcher.on('unlinkDir', scheduleTreeChange)
}

interface RunEntry {
  source: 'npm' | 'custom'
  name: string
  command: string
  description?: string
}

async function readPackageRuns(rootPath: string): Promise<RunEntry[]> {
  try {
    const raw = await fs.readFile(join(rootPath, 'package.json'), 'utf-8')
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> }
    if (!parsed.scripts) return []
    return Object.keys(parsed.scripts)
      .sort()
      .map((name) => ({
        source: 'npm' as const,
        name,
        command: `npm run ${shellEscape(name)}`
      }))
  } catch {
    return []
  }
}

async function readCustomRuns(rootPath: string): Promise<RunEntry[]> {
  // Agent-maintained free-form runs at .codeswim/runs.json. Format:
  //   [{ "name": "Smoke API", "command": "tsx scripts/smoke.ts" }, ...]
  // Optional fields: `description` (tooltip). Unknown fields are ignored.
  try {
    const raw = await fs.readFile(join(rootPath, '.codeswim', 'runs.json'), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out: RunEntry[] = []
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue
      const e = entry as Record<string, unknown>
      if (typeof e.name !== 'string' || !e.name.trim()) continue
      if (typeof e.command !== 'string' || !e.command.trim()) continue
      out.push({
        source: 'custom',
        name: e.name,
        command: e.command,
        description: typeof e.description === 'string' ? e.description : undefined
      })
    }
    return out
  } catch {
    return []
  }
}

async function listRuns(rootPath: string): Promise<RunEntry[]> {
  const [pkg, custom] = await Promise.all([
    readPackageRuns(rootPath),
    readCustomRuns(rootPath)
  ])
  return [...custom, ...pkg]
}

function killActiveRun(): void {
  if (!activeRun) return
  const { child } = activeRun
  if (child.killed || child.pid === undefined) return
  if (process.platform === 'win32') {
    // Windows has no POSIX process groups, so a negative-pid signal can't
    // reach the tree. taskkill /T kills the whole tree (the cmd shell, npm,
    // and the vite/tsx grandchildren it spawned); /F forces it.
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    } catch {
      try {
        child.kill()
      } catch {
        // child already gone
      }
    }
    return
  }
  try {
    // Negative pid signals the entire process group spawned with detached: true.
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    try {
      child.kill('SIGTERM')
    } catch {
      // child already gone
    }
  }
}

function emitScriptOutput(name: string, stream: 'stdout' | 'stderr', chunk: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('script-output', { name, stream, chunk })
}

function emitScriptExit(name: string, code: number | null, signal: NodeJS.Signals | null): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('script-exit', { name, code, signal })
}

async function runEntry(rootPath: string, source: 'npm' | 'custom', name: string): Promise<void> {
  // Re-read the current list so the renderer can never invent a command
  // string over IPC — we always run something the user could see in the
  // (validated) merged list.
  const runs = await listRuns(rootPath)
  const entry = runs.find((r) => r.source === source && r.name === name)
  if (!entry) {
    throw new Error(`unknown run: ${source}/${name}`)
  }

  killActiveRun()

  // Use shell so the user's PATH (npm, pnpm, node, tsx) resolves the way
  // it does in their terminal. detached:true creates a new process group
  // so we can kill the whole tree (npm spawns subcommands).
  const child = spawn(entry.command, {
    cwd: rootPath,
    shell: true,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Stops a console window flashing up on Windows (no-op elsewhere).
    windowsHide: true,
    // FORCE_COLOR=1 makes tools that gate colour on a TTY (vite, npm, tsx…)
    // emit ANSI even though we pipe stdout; the output panel parses those
    // codes into styled spans. COLUMNS keeps wrap-aware tools from assuming
    // an 80-col terminal and hard-wrapping into the narrow panel.
    env: { ...process.env, FORCE_COLOR: '1', COLUMNS: '120' }
  })

  const run: ScriptRun = { name, child, startedAt: Date.now() }
  activeRun = run

  child.stdout?.on('data', (buf: Buffer) => {
    if (activeRun !== run) return
    emitScriptOutput(name, 'stdout', buf.toString('utf-8'))
  })
  child.stderr?.on('data', (buf: Buffer) => {
    if (activeRun !== run) return
    emitScriptOutput(name, 'stderr', buf.toString('utf-8'))
  })
  child.on('error', (err) => {
    if (activeRun !== run) return
    emitScriptOutput(name, 'stderr', `\n[spawn error] ${err.message}\n`)
  })
  child.on('close', (code, signal) => {
    if (activeRun === run) activeRun = null
    emitScriptExit(name, code, signal)
  })
}

function shellEscape(s: string): string {
  // Names come from package.json scripts (we validated above) but quote
  // anyway in case they contain spaces or shell metacharacters.
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// ---- Recent projects + new project scaffolding ----

const RECENTS_LIMIT = 12

function recentsPath(): string {
  return join(app.getPath('userData'), 'recent-projects.json')
}

async function readRecents(): Promise<string[]> {
  try {
    const raw = await fs.readFile(recentsPath(), 'utf-8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((s): s is string => typeof s === 'string').slice(0, RECENTS_LIMIT)
  } catch {
    return []
  }
}

async function writeRecents(list: string[]): Promise<void> {
  try {
    await fs.mkdir(dirname(recentsPath()), { recursive: true })
    await fs.writeFile(recentsPath(), JSON.stringify(list, null, 2), 'utf-8')
  } catch {
    // best-effort; don't crash if userData isn't writable
  }
}

async function addRecent(path: string): Promise<string[]> {
  const current = await readRecents()
  const filtered = current.filter((p) => p !== path)
  const next = [path, ...filtered].slice(0, RECENTS_LIMIT)
  await writeRecents(next)
  rebuildAppMenu(next)
  return next
}

function escapeMermaidLabel(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

async function scaffoldOverview(folderPath: string): Promise<void> {
  const name = basename(folderPath)
  const overview = `---
name: ${name}
description: TODO — describe this project in one line.
tags: [overview]
---

This is a new codeswim project. Edit \`overview.md\` to describe the system,
then add diagrams under \`architecture/\` and \`flows/\` and source code under
\`src/\`. Every node in the mermaid block should have a \`click\` handler so
readers can drill into it.

\`\`\`mermaid
flowchart TD
    Start["${escapeMermaidLabel(name)}"] --> Plan[Sketch the system]
    Plan --> Code[Write the code]

    click Start call navigate("./overview.md")
    click Plan call navigate("./overview.md")
    click Code call navigate("./overview.md")
\`\`\`
`
  await fs.writeFile(join(folderPath, 'overview.md'), overview, 'utf-8')
}

interface NewProjectResult {
  path: string
  created: boolean
}

async function newProject(): Promise<NewProjectResult | null> {
  if (!mainWindow) return null
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'New codeswim project',
    buttonLabel: 'Create',
    nameFieldLabel: 'Project name:',
    defaultPath: 'my-project',
    properties: ['createDirectory', 'showOverwriteConfirmation']
  })
  if (result.canceled || !result.filePath) return null
  const target = result.filePath
  let created = false
  try {
    await fs.mkdir(target, { recursive: true })
    const existing = await fs.readdir(target)
    if (existing.length === 0) {
      await scaffoldOverview(target)
      created = true
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Could not create project at ${target}: ${msg}`)
  }
  await addRecent(target)
  return { path: target, created }
}

// ---- App menu (rebuilds when recents change so "Open Recent" stays fresh) ----

function buildAppMenu(recents: string[] = []): Menu {
  const isMac = process.platform === 'darwin'

  const recentItems: MenuItemConstructorOptions[] =
    recents.length === 0
      ? [{ label: '(no recent projects)', enabled: false }]
      : recents.map((p) => ({
          label: p,
          click: () => mainWindow?.webContents.send('menu:open-recent', p)
        }))

  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      {
        label: 'New Project…',
        accelerator: 'CmdOrCtrl+N',
        click: () => mainWindow?.webContents.send('menu:new-project')
      },
      {
        label: 'Open Folder…',
        accelerator: 'CmdOrCtrl+O',
        click: () => mainWindow?.webContents.send('menu:open-folder')
      },
      {
        label: 'Open Recent',
        submenu: [
          ...recentItems,
          { type: 'separator' },
          {
            label: 'Clear Recents',
            enabled: recents.length > 0,
            click: () => {
              void writeRecents([]).then(() => rebuildAppMenu([]))
              mainWindow?.webContents.send('menu:recents-cleared')
            }
          }
        ]
      },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit' }
    ]
  }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? ([{ role: 'appMenu' }] as MenuItemConstructorOptions[]) : []),
    fileMenu,
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]

  return Menu.buildFromTemplate(template)
}

function rebuildAppMenu(recents: string[]): void {
  Menu.setApplicationMenu(buildAppMenu(recents))
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.codeswim.codeswim')
  // Build the menu with the persisted recents so "Open Recent" works on
  // first launch (rebuilds whenever the list changes via addRecent).
  const initialRecents = await readRecents()
  Menu.setApplicationMenu(buildAppMenu(initialRecents))

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle('pick-folder', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const picked = result.filePaths[0]
    await addRecent(picked)
    return picked
  })

  ipcMain.handle('new-project', async () => {
    return newProject()
  })

  ipcMain.handle('get-recents', async () => {
    return readRecents()
  })

  ipcMain.handle('clear-recents', async () => {
    await writeRecents([])
    rebuildAppMenu([])
    return []
  })

  ipcMain.handle('add-recent', async (_event, path: string) => {
    return addRecent(path)
  })

  ipcMain.handle('read-file', async (_event, absPath: string) => {
    return fs.readFile(absPath, 'utf-8')
  })

  ipcMain.handle('list-markdown', async (_event, rootPath: string) => {
    const out: string[] = []
    await walkMarkdown(rootPath, out)
    return out
  })

  ipcMain.handle('list-tree', async (_event, rootPath: string) => {
    return listTree(rootPath)
  })

  ipcMain.handle('watch', async (_event, rootPath: string) => {
    startWatching(rootPath)
  })

  ipcMain.handle('unwatch', async () => {
    stopWatching()
  })

  ipcMain.handle('list-runs', async (_event, rootPath: string) => {
    return listRuns(rootPath)
  })

  ipcMain.handle(
    'run-entry',
    async (_event, rootPath: string, source: 'npm' | 'custom', name: string) => {
      await runEntry(rootPath, source, name)
    }
  )

  ipcMain.handle('kill-script', async () => {
    killActiveRun()
  })

  ipcMain.handle('harness:start', async (_event, rootPath: string) => {
    if (sidecar && sidecarRoot === rootPath) {
      return { url: sidecar.url.toString() }
    }
    if (sidecar && sidecarRoot !== rootPath) {
      await sidecar.stop()
      sidecar = null
      sidecarRoot = null
    }
    if (!sidecarStarting) {
      sidecarStarting = startSidecar({
        workspaceRoot: rootPath,
        onStdout: (line) => mainWindow?.webContents.send('harness:log', { stream: 'stdout', line }),
        onStderr: (line) => mainWindow?.webContents.send('harness:log', { stream: 'stderr', line }),
        onExit: (code, info) => {
          mainWindow?.webContents.send('harness:exit', {
            code,
            signal: info.signal,
            stderrTail: info.stderrTail
          })
          sidecar = null
          sidecarRoot = null
        }
      }).finally(() => {
        sidecarStarting = null
      })
    }
    sidecar = await sidecarStarting
    sidecarRoot = rootPath
    return { url: sidecar.url.toString() }
  })

  ipcMain.handle('harness:stop', async () => {
    if (!sidecar) return
    await sidecar.stop()
    sidecar = null
    sidecarRoot = null
  })

  ipcMain.handle('skills:list', async (_event, rootPath: string | null) => {
    return listSkills(rootPath)
  })

  ipcMain.handle(
    'skills:read',
    async (_event, scope: SkillScope, name: string, rootPath: string | null) => {
      return readSkill(scope, name, rootPath)
    }
  )

  ipcMain.handle(
    'skills:write',
    async (_event, scope: SkillScope, name: string, content: string, rootPath: string | null) => {
      await writeSkill(scope, name, content, rootPath)
    }
  )

  ipcMain.handle(
    'skills:delete',
    async (_event, scope: SkillScope, name: string, rootPath: string | null) => {
      await deleteSkill(scope, name, rootPath)
    }
  )

  ipcMain.handle('skills:pick-link-source', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Pick a folder of skills',
      buttonLabel: 'Link skills from here',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(
    'skills:link-folder',
    async (_event, scope: 'global' | 'workspace', sourcePath: string, rootPath: string | null) => {
      return linkFolder(scope, sourcePath, rootPath)
    }
  )

  ipcMain.handle(
    'skills:open-in-editor',
    async (
      _event,
      scope: SkillScope,
      name: string,
      rootPath: string | null,
      relPath?: string
    ) => {
      const filePath = resolveSkillFilePath(scope, name, rootPath, relPath)
      // shell.openPath returns "" on success, or a stringified error message
      // on failure (e.g. no app registered for .md). Surface failures so the
      // renderer can toast them.
      const err = await shell.openPath(filePath)
      if (err) throw new Error(err)
    }
  )

  ipcMain.handle(
    'skills:list-files',
    async (_event, scope: SkillScope, name: string, rootPath: string | null) => {
      return listSkillFiles(scope, name, rootPath)
    }
  )

  ipcMain.handle(
    'skills:read-file',
    async (
      _event,
      scope: SkillScope,
      name: string,
      relPath: string,
      rootPath: string | null
    ) => {
      return readSkillFile(scope, name, relPath, rootPath)
    }
  )

  ipcMain.handle(
    'skills:write-file',
    async (
      _event,
      scope: SkillScope,
      name: string,
      relPath: string,
      content: string,
      rootPath: string | null
    ) => {
      await writeSkillFile(scope, name, relPath, content, rootPath)
    }
  )

  ipcMain.handle('git:status', async (_event, rootPath: string) => {
    return gitStatus(rootPath)
  })

  ipcMain.handle('git:staged-diff', async (_event, rootPath: string) => {
    return gitStagedDiff(rootPath)
  })

  ipcMain.handle(
    'git:commit',
    async (_event, rootPath: string, subject: string, body: string) => {
      return gitCommit(rootPath, subject, body)
    }
  )

  ipcMain.handle('git:init', async (_event, rootPath: string) => {
    return gitInit(rootPath)
  })

  ipcMain.handle('git:stage-all', async (_event, rootPath: string) => {
    await gitStageAll(rootPath)
  })

  ipcMain.handle('git:unstage-all', async (_event, rootPath: string) => {
    await gitUnstageAll(rootPath)
  })

  ipcMain.handle('git:log', async (_event, rootPath: string, limit?: number) => {
    return gitLog(rootPath, limit)
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopWatching()
  killActiveRun()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  killActiveRun()
  if (sidecar) {
    void sidecar.stop()
    sidecar = null
    sidecarRoot = null
  }
})
