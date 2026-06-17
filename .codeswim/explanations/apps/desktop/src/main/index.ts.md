---
name: Main Process Entry
description: Electron main process entry point — window creation, all IPC handlers, chokidar watcher, npm script runner, node-pty terminals, and the opencode sidecar supervisor.
tags: [main, electron, ipc, filesystem]
---

## Purpose

`apps/desktop/src/main/index.ts` is the single entry point for codeswim's main (Node) process. It owns every capability the renderer cannot reach directly through the browser sandbox: reading and writing files, spawning subprocesses, watching the filesystem, managing terminal PTYs, and running the opencode sidecar. It is the authority on the workspace filesystem — the renderer never touches an absolute path.

## Responsibilities

- **BrowserWindow lifecycle** — creates the single app window with hardened `webPreferences` (`contextIsolation: true`, `nodeIntegration: false`), wires macOS `activate` re-creation, and cleans up on `window-all-closed`.
- **IPC handler registration** — registers every `ipcMain.handle`/`.on` call the renderer invokes through the [preload bridge](../../../architecture/preload.md). Roughly 30 handlers covering filesystem I/O, git, kanban, skills, the harness sidecar, terminal management, the script runner, and recent-project tracking.
- **File watcher** — starts a [chokidar](https://github.com/paulmillr/chokidar) instance on the picked workspace; emits `file-changed` on every edit and a debounced (200ms) `tree-changed` on add/unlink. Ignores dotfiles (except `.env`, `.gitignore`, `.codeswim`), `node_modules`, `dist`, `out`, `build`, and `.git`.
- **Script runner** — spawns npm/custom commands via `child_process.spawn` with `shell: true, detached: true` so the user's PATH resolves. Kills the whole process group on stop (negative-pid `SIGTERM` on POSIX, `taskkill /T /F` on Windows).
- **Terminal PTY** — creates per-tab pseudo-terminals via `node-pty` on a `SHELL` (default `/bin/zsh`). Manages a `terminals` map keyed by auto-incrementing IDs.
- **App menu** — builds a macOS-style File menu with New Project, Open Folder, and a live Open Recent submenu persisted to `userData/recent-projects.json`.
- **New project scaffolding** — shows a native save dialog, creates the directory, and writes a minimal `overview.md` with a starter mermaid diagram.
- **Recents management** — reads/writes a `recent-projects.json` file in Electron's `userData` directory, capped at 12 entries. The app menu's Open Recent submenu rebuilds whenever the list changes.
- **Sidecar supervision** — starts and stops the opencode sidecar subprocess for the [agent harness](../../../architecture/agent-harness.md). Tracks one sidecar per workspace root, re-creating it if the root changes. Forwards stdout/stderr and exit events to the renderer.

## Inputs and outputs

### Inputs

All inputs arrive as IPC invocations from the renderer via the preload bridge. Key channels:

| Channel | Input | What it triggers |
|---|---|---|
| `pick-folder` | — | Native directory picker dialog |
| `read-file` | `absPath: string` | `fs.readFile(absPath, 'utf-8')` |
| `list-tree` | `rootPath: string` | Recursive directory walk → `TreeNode[]` |
| `watch` / `unwatch` | `rootPath: string` | Chokidar start/stop |
| `run-entry` / `kill-script` | run name | Spawn / kill npm/custom script |
| `git:*` | various | Delegates to `git.ts` functions |
| `kanban:*` | board data | Delegates to `kanban.ts` functions |
| `harness:start` / `harness:stop` | `rootPath: string` | opencode sidecar lifecycle |
| `terminal:create` / `:write` / `:resize` / `:destroy` | terminal ID + data | node-pty operations |
| `room:identity` | `rootPath: string` | Delegates to `room.ts` |
| `skills:*` | scope, name, content | Delegates to `skills.ts` |
| `new-project` | — | Native save dialog → scaffold → add to recents |

### Outputs

Outputs are sent to the renderer via `mainWindow.webContents.send()`:

- **`file-changed`** — absolute path of a changed file (watcher).
- **`tree-changed`** — no payload; signals the renderer to re-request `list-tree`.
- **`script-output`** — `{ name, stream, chunk }` where stream is `'stdout'` or `'stderr'`.
- **`script-exit`** — `{ name, code, signal }`.
- **`harness:log`** — `{ stream, line }` from the sidecar subprocess.
- **`harness:exit`** — `{ code, signal, stderrTail }`.
- **`terminal:data`** — `(id, data)` PTY output.
- **`terminal:exit`** — `(id)` PTY process ended.
- **`menu:*`** — menu action events forwarded from the native app menu.

## Control and data flow

```
app.whenReady()
  → read recents from userData
  → build app menu (with recents submenu)
  → register all ipcMain.handle/.on handlers
  → createWindow()  (BrowserWindow)
  → enter event loop

Renderer IPC call  →  handler in index.ts
  → delegates to internal module (git.ts, kanban.ts, skills.ts, sidecar.ts, etc.)
  → returns result through IPC

Filesystem watcher  →  chokidar emits change/add/unlink
  → mainWindow.webContents.send('file-changed' | 'tree-changed')
```

The file never calls renderer functions directly — all communication is IPC or `webContents.send`. This is the architectural boundary that keeps the renderer sandboxed.

## Dependencies and side effects

### Internal modules

- `./sidecar` — starts/stops the opencode sidecar subprocess.
- `./skills` — discovers and manages SKILL.md files across global, workspace, and built-in scopes.
- `./git` — safe `execFile` wrappers for git status, diff, commit, init, log, etc.
- `./kanban` — JSON-backed kanban board with optional GitHub issue sync.
- `./room` — derives a stable chat-room identity from the repo's origin remote.
- `./source-explanations` — resolves and reads companion `.codeswim/explanations/*.md` documents.

### External modules

- `electron` — `app`, `BrowserWindow`, `ipcMain`, `dialog`, `shell`, `Menu`.
- `chokidar` — filesystem watcher (ignored paths mirror `TREE_IGNORED_DIRS`).
- `node-pty` — PTY spawns for the terminal panel.
- `child_process` — `spawn` for the script runner and `taskkill` on Windows.

### Side effects

- Writes `recent-projects.json` to `app.getPath('userData')` on every folder pick and `addRecent` call.
- Scaffolds a new directory with `overview.md` on `new-project`.
- Spawns child processes (npm scripts, opencode sidecar, terminal PTYs) that must be cleaned up on quit.
- Reads `package.json` and `.codeswim/runs.json` to build the run list.
- The native app menu is rebuilt whenever recents change.

## Failure modes

- **Watcher errors** — chokidar failures are silently caught (`on('error')` is not wired). A broken watcher means stale file tree and no live reload; the user must re-open the folder.
- **Script spawn failure** — surfaced to the renderer as a `[spawn error]` stderr message through `script-output`. The child process `error` event is caught and emitted.
- **File read errors** — `ipcMain.handle('read-file', ...)` propagates the `fs.readFile` exception to the renderer as a rejected promise. The renderer should handle it gracefully.
- **Sidecar already running** — protected by the `sidecarStarting` promise gate; concurrent `harness:start` calls share a single in-flight start. Restarting for a different root stops the old sidecar first.
- **Terminal zombie** — PTY processes are tracked in a Map and cleaned up on exit via their `onExit` callback. A missing `terminal:destroy` call leaves a shell running — the terminal panel always calls destroy on unmount.
- **App quit** — `before-quit` kills the active script run and stops the sidecar. `window-all-closed` also kills the active run and stops the watcher. On macOS the app may stay running (no `app.quit()`), so the sidecar may persist across window closes.

## Related diagrams and decisions

- [Main process architecture](../../../architecture/main-process.md) — the owning diagram; shows how `index.ts` routes IPC to picker, reader, watcher, scripts, skills, and the harness.
- [Agent harness](../../../architecture/agent-harness.md) — the `harness:start` / `harness:stop` handlers are the main process side of sidecar supervision.
- [Preload bridge](../../../architecture/preload.md) — the IPC contract (`DiagramNavApi`) that every handler here implements.
- [Prompt Commits](../../../architecture/prompt-commits.md) — registers the `git:*` IPC handlers documented in the IPC contract additions table. The handler names must match what `git.ts` exports.
- The [main-process diagram](../../../architecture/main-process.md) notes explain why `runEntry` uses `detached: true` (process group cleanup) and why `tree-changed` debounces at 200ms (multi-step editor writes).
