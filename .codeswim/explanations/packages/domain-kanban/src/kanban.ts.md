---
name: Kanban Board Persistence and GitHub Sync
description: Main-process module that reads/writes .codeswim/board.json and syncs with GitHub Projects via the gh CLI.
tags: [main, kanban, github, filesystem]
---

## Purpose

Persists the project kanban board to `.codeswim/board.json` and optionally synchronizes its columns and cards with a GitHub Project. The renderer never touches the filesystem directly — all board reads, writes, syncs, and status moves go through this module.

## Responsibilities

- **Read the board** — loads and normalizes `.codeswim/board.json`, returning a default board when the file doesn't exist.
- **Write the board** — normalizes the board data and writes it atomically (temp file + rename) to `.codeswim/board.json`.
- **Sync with GitHub** — queries a GitHub Project via the `gh` CLI for its current state (columns/status options, items), merges the result into the local board, and writes the updated board back.
- **Push card moves to GitHub** — updates a GitHub item's status field to reflect a card being dragged to a new column, using the cached project and field IDs from the last sync.
- **Merge GitHub data** — combines imported GitHub items with existing local-only cards, matching cards by their GitHub item ID so existing metadata (priority, linked path) is preserved across syncs.

## Inputs and outputs

### Inputs

All inputs arrive as IPC invocations from the renderer via the preload bridge:

| IPC channel | Payload | Route |
|---|---|---|
| `kanban:read` | `rootPath` | `readKanbanBoard` |
| `kanban:write` | `rootPath, board` | `writeKanbanBoard` |
| `kanban:sync` | `rootPath, board` | `syncKanbanWithGitHub` |
| `kanban:move` | `rootPath, board, cardId, columnId` | `moveGitHubKanbanItem` |

### Outputs

All four functions return a normalized `KanbanBoard` object. `moveGitHubKanbanItem` returns nothing on success.

## Control and data flow

```
Renderer IPC → handler in index.ts → kanban.ts function
                                       → fs.readFile / fs.writeFile (.codeswim/board.json)
                                       → or: execFile('gh', ...) for GitHub operations
                                       → normalizeKanbanBoard (@codeswim/contract)
                                       → return KanbanBoard to renderer
```

For GitHub sync specifically:

```
syncKanbanWithGitHub(board)
  → Promise.all(3 gh commands): view project, field-list, item-list
  → mergeGitHubSnapshot(board, project, fields, items)
      → parse GitHub status field options → map to board columns
      → merge GitHub items with local-only cards (matched by itemId)
      → return merged board
  → writeKanbanBoard (persist)
```

The merge logic in `mergeGitHubSnapshot` is pure — it takes structured data and returns a new `KanbanBoard` without side effects, making it testable. All I/O is isolated in the top-level exported functions.

## Dependencies and side effects

### Internal

- `@codeswim/contract` — type definitions (`KanbanBoard`, `KanbanCard`, `KanbanColumn`, `KanbanGitHubConfig`) and the `normalizeKanbanBoard` / `createDefaultKanbanBoard` validation helpers. Every board write runs through normalisation so corrupt or hand-edited JSON is repaired before persistence.

### External

- `node:fs` (promises) — all board file I/O.
- `node:path` — constructs `.codeswim/board.json` from the workspace root.
- `node:child_process` — `execFile` to invoke the `gh` CLI for GitHub Project operations.

### Side effects

- Writes to `.codeswim/board.json` (and a `.tmp` file during atomic write).
- Spawns the `gh` subprocess during sync and item move operations.
- The write uses a temp-file + rename pattern to avoid corrupting the board on partial write (disk full, crash).

## Failure modes

| Condition | Behaviour |
|---|---|
| Board file missing (ENOENT) | Returns a default `KanbanBoard` with the standard five columns and an empty card list. |
| Board file contains invalid JSON | Throws `Invalid JSON in .codeswim/board.json`. |
| `gh` CLI not installed | Throws a descriptive error asking the user to install and authenticate `gh`. |
| GitHub command fails (API error, network) | Throws the `stderr` or error message from the `gh` process. |
| No GitHub config on board | `syncKanbanWithGitHub` throws `Connect a GitHub Project before syncing.` |
| Missing status field or project ID | `moveGitHubKanbanItem` throws `Sync the board with GitHub before pushing status changes.` |
| GitHub column name has no matching status option | The card move is silently skipped — the item stays in its current GitHub column. |
| `fs.writeFile` / `fs.rename` fails | The temp file may be left behind. The error propagates to the callers in `index.ts`. |

## Related diagrams and decisions

- [Main process architecture](../../../../../architecture/main-process.md) — lists `kanban.ts` in the Source section and shows where it fits among the main-process modules.
- [Agent harness](../../../../../architecture/agent-harness.md) — the `kanban_add` tool in the opencode plugin calls back through the main process to this module to persist new cards.
- [Main process entry explanation](../../../apps/desktop/src/main/index.ts.md) — documents the IPC channel routing and the full set of main-process modules.
