# Diagram-First Code Navigator

## What we're building

A desktop app for navigating a codebase as a hierarchy of mermaid diagrams. The user points it at a folder containing markdown files with embedded mermaid diagrams, and the app lets them click through nested diagrams down to source code.

The core thesis: as AI generates more code, humans should navigate architecture through intentional diagrams, not by reading thousands of lines of generated implementation. The diagrams live in the repo as markdown files. They are the source of truth for understanding the system; the code is a leaf-level implementation detail you only open when you need to verify or modify something specific.

## Scope of v1

This is a **read-only navigator**. No diagram authoring inside the app. Users edit `.md` files in their normal editor; the app watches for changes and re-renders.

In scope:

- Pick a root folder containing architecture markdown files
- Render mermaid diagrams from markdown files
- Click a node to navigate to a child diagram or open a source file
- Breadcrumb navigation showing where you are in the hierarchy
- Live reload when underlying files change
- Code panel for viewing source files at leaf nodes

Out of scope for v1:

- Editing diagrams in-app
- Generating diagrams from code
- Multi-repo support
- Search across diagrams
- CI checks or staleness detection
- Agent integration

## Stack

- **Electron** with `electron-vite` scaffold
- **React** for the renderer UI
- **TypeScript** throughout
- **mermaid** (npm package) for diagram rendering
- **gray-matter** for parsing markdown frontmatter
- **chokidar** for file watching in the main process
- **Monaco** or **CodeMirror 6** for the code view (CodeMirror is lighter, prefer it)

## File format

Architecture lives in markdown files with YAML frontmatter and mermaid code blocks. Example:

````markdown
---
name: billing
description: Handles charges, refunds, and subscription lifecycle
tags: [service, payments]
---

The billing subsystem owns all money-moving operations. It depends on auth
for user identity and emits events to the analytics pipeline.

​```mermaid
flowchart TD
API[API Gateway] --> Charge[Charge Service]
API --> Refund[Refund Service]
Charge --> DB[(Billing DB)]
Refund --> DB

    click Charge call navigate("./charge-flow.md")
    click Refund call navigate("./src/billing/refund.ts")
    click DB call navigate("./billing-db.md")

​```
````

Key conventions:

- Frontmatter has `name` (required), `description` (required), `tags` (optional)
- Exactly one mermaid code block per file (v1 assumption — fail loudly if there are multiple)
- Navigation uses mermaid's `click NodeId call navigate("path")` syntax
- Paths in `navigate(...)` are resolved relative to the current file's directory
- A path ending in `.md` loads as a child diagram; anything else opens its companion Markdown explanation

## Architecture

Standard Electron three-process model:

**Main process** (`src/main/`): filesystem access, folder picking, file watching, IPC handlers.

**Preload** (`src/preload/`): exposes a minimal API to the renderer via `contextBridge`. Keep `contextIsolation: true` and `nodeIntegration: false`.

**Renderer** (`src/renderer/`): React app. Owns all UI state including current diagram, breadcrumb stack, and source explanation contents.

### Preload API

```ts
window.api = {
  pickFolder(): Promise<string | null>          // opens OS folder picker, returns absolute path or null
  readFile(absPath: string): Promise<string>    // reads file as utf-8
  listMarkdown(rootPath: string): Promise<string[]>  // returns absolute paths of all .md files under root
  watch(rootPath: string): void                 // start watching; emits 'file-changed' events
  onFileChanged(cb: (absPath: string) => void): () => void  // subscribe; returns unsubscribe
}
```

### Path resolution

The renderer never deals in absolute paths in user-facing logic. It tracks:

- `rootPath`: absolute path the user picked, set once
- `currentFile`: path relative to `rootPath`

When a `click ... call navigate("./foo.md")` fires, resolve `./foo.md` relative to `currentFile`'s directory, normalize, and that becomes the new `currentFile`. Pass the absolute path (`rootPath + currentFile`) to `readFile`.

This keeps diagrams portable — the same architecture folder works on any machine because all internal references are relative.

## UI layout

Single window, three regions:

```
┌─────────────────────────────────────────────────┐
│  Breadcrumbs: overview > billing > charge-flow  │
├─────────────────────────────────────────────────┤
│                                                 │
│              Diagram Canvas                     │
│              (or code view)                     │
│                                                 │
│                                                 │
└─────────────────────────────────────────────────┘
```

When viewing a diagram: render the mermaid block, plus the description from frontmatter shown above or below it (designer's call — try above first).

When viewing code: full-pane CodeMirror with syntax highlighting. A "back" affordance returns to the previous diagram. Browser-style back button in the breadcrumb area is fine.

Breadcrumbs are clickable — clicking an earlier crumb pops the stack back to that point.

Keep the visual design minimal in v1. White background, system font, mermaid's default theme. Don't spend time on aesthetics until the interaction feels right.

## Mermaid integration

Initialize mermaid with:

```ts
mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'loose', // required for click callbacks to work
  theme: 'default'
})
```

Register the navigation callback globally so mermaid's `click NodeId call navigate(...)` resolves to your handler:

```ts
window.navigate = (path: string) => {
  // your routing logic
}
```

Render diagrams imperatively with `mermaid.render(id, code)` — don't rely on `startOnLoad`. Each time the current file changes, clear the canvas and re-render.

## File watching and live reload

When the user picks a root folder, start a chokidar watcher on it (main process). On any `.md` file change, send an IPC message to the renderer with the absolute path. If the changed file is the currently-displayed file, re-read and re-render. Otherwise ignore for now (v2 might invalidate caches).

Debounce file change events at ~100ms — editors often write files in multiple operations.

## State model

Renderer state is small enough to live in a single React context or Zustand store. Roughly:

```ts
type State = {
  rootPath: string | null
  currentFile: string | null // relative to rootPath
  breadcrumbs: string[] // stack of relative paths
  view: 'diagram' | 'code'
  fileContents: string | null // cached contents of currentFile
}
```

Navigation actions:

- `setRoot(path)`: sets rootPath, loads the entry diagram (convention: `overview.md` at root, fall back to first `.md` found)
- `navigateTo(relativePath)`: pushes current onto breadcrumbs, loads new file, switches view based on extension
- `popTo(index)`: truncates breadcrumb stack, loads the file at that index

## Error handling

- File not found at a `navigate(...)` target: show a non-blocking error toast, stay on current view
- Markdown file with no mermaid block: show the prose with a warning banner
- Markdown file with multiple mermaid blocks: render the first, warn
- Mermaid parse error: show the raw mermaid text in a code block with the error message above it
- Frontmatter missing `name` or `description`: render anyway, no warning needed (they're nice-to-have for v1)

## Build and run

```bash
npm create @quick-start/electron@latest diagram-nav -- --template react-ts
cd diagram-nav
npm install mermaid gray-matter chokidar @codemirror/state @codemirror/view @codemirror/lang-javascript
npm run dev
```

Use `electron-builder` for packaging when needed; not required for development.

## Test fixture

Create a `examples/sample-architecture/` folder in the repo with a small hand-authored hierarchy to develop against:

```
examples/sample-architecture/
  overview.md           # 5-7 nodes, links to billing.md, auth.md, api.md
  billing.md            # links to charge-flow.md, src/billing/charge.ts
  charge-flow.md        # leaf diagram, links to source files
  auth.md
  api.md
  src/
    billing/
      charge.ts         # stub file with a few functions
      refund.ts
    auth/
      login.ts
```

This lets the developer verify navigation works end-to-end without needing a real codebase.

## Definition of done for v1

- Pick a folder, see the overview diagram render
- Click a node that links to another `.md`, see the new diagram render with breadcrumbs updated
- Click a node that links to a source file, see the file contents in a code view
- Click breadcrumbs to navigate back up the stack
- Edit a diagram file in an external editor, see the change reflected in the app within ~1 second
- All of the above works against the sample architecture fixture
