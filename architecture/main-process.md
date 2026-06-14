---
name: Main Process
description: Electron main process — owns the filesystem, IPC handlers, chokidar watcher, npm script runner, and skills indexer.
tags: [main, electron, ipc]
---

The main process is the only side of the app that touches the filesystem
directly. It registers every IPC handler the renderer can call, watches
the picked workspace for changes, spawns npm scripts in detached process
groups so their grandchildren can be killed cleanly, and indexes user
skill files. Spawning the `opencode` sidecar also originates here — see
the [Agent harness](./agent-harness.md) doc for that flow.

```mermaid
flowchart TD
    Renderer((Renderer)) -->|IPC| Index[main/index.ts<br/>IPC handlers]
    Index --> Picker[pick-folder]
    Index --> Reader[read-file / list-tree]
    Index --> Watcher[chokidar watcher]
    Index --> Scripts[run-script / kill-script]
    Index --> Skills[skills.ts<br/>list/read SKILL.md]
    Index --> Harness[start-harness]
    Watcher -->|file-changed,<br/>tree-changed| Renderer
    Scripts -->|spawn npm run,<br/>detached| Group[(process group)]
    Harness -->|opencode serve| Sidecar((Sidecar))
    Skills --> SkillFs[(global + workspace<br/>.agents/skills/)]

    click Renderer call navigate("../overview.md")
    click Picker call navigate("../src/main/index.ts")
    click Reader call navigate("../src/main/index.ts")
    click Watcher call navigate("../src/main/index.ts")
    click Scripts call navigate("../src/main/index.ts")
    click Group call navigate("./main-process.md")
    click Sidecar call navigate("./agent-harness.md")
    click SkillFs call navigate("./main-process.md")
    click Index call navigate("../src/main/index.ts")
    click Skills call navigate("../src/main/skills.ts")
    click Harness call navigate("./agent-harness.md")
```

## Notes

- IPC handler names are the contract; they must match what the [preload bridge](./preload.md) exposes.
- The watcher debounces `tree-changed` at 200ms because editors fire multiple events per save (rename + write).
- Script names are validated against parsed `package.json` scripts before spawning, then shell-quoted.
- The `detached: true` flag matters: `npm run foo` itself spawns grandchildren (e.g. `tsx`, `vitest`); without a process group we'd leak them on stop.

## Source

- [src/main/index.ts](../src/main/index.ts) — process entry, BrowserWindow, every IPC handler, chokidar watcher, npm script runner.
- [src/main/skills.ts](../src/main/skills.ts) — discovers global + workspace SKILL.md files and exposes a read API to the renderer.
- [src/main/kanban.ts](../src/main/kanban.ts) — Kanban board read/write and GitHub issue sync.
- [src/main/room.ts](../src/main/room.ts) — room identity management for chat.
- [src/main/source-explanations.ts](../src/main/source-explanations.ts) — companion explanation path resolution and read.
- [src/main/agents-doc.ts](../src/main/agents-doc.ts) — reads and writes AGENTS.md files (workspace scope and global ~/.agents/ scope).
- [src/shared/chat.ts](../src/shared/chat.ts) — shared chat types used by main and renderer.
- [src/shared/kanban.ts](../src/shared/kanban.ts) — shared kanban types used by main and renderer.

### Testing

- [src/main/kanban.test.ts](../src/main/kanban.test.ts) — covers the main-process kanban operations.
- [src/main/room.test.ts](../src/main/room.test.ts) — covers the room identity logic.
- [src/main/source-explanations.test.ts](../src/main/source-explanations.test.ts) — covers explanation path resolution.
