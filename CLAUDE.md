# Diagram-First Code Navigator (Electron app)

A standalone Electron desktop app for navigating a codebase as a hierarchy
of mermaid diagrams. The original of the idea — `codeswim-vscode`
is the same idea ported to a VS Code extension, and `codeswim-example`
is the demo content both target.

The thesis (from [plan.md](./plan.md)): as AI generates more code, humans
should navigate architecture through intentional diagrams, not by reading
generated implementation. Diagrams live as markdown files; this app makes
them clickable.

## Monorepo layout

This is an npm-workspaces + Turborepo monorepo. The Electron app lives in
`apps/desktop`; framework-free logic is extracted into `packages/*` and
consumed as TypeScript source — there is no per-package build step,
electron-vite bundles the workspace source directly:

- `@codeswim/contract` — IPC payload types + the `DiagramNavApi` surface;
  the versioned seam between main, preload, and renderer.
- `@codeswim/domain-git` / `-github` / `-kanban` / `-skills` / `-unbiased` — Electron-free
  domain logic. Electron-coupled pieces (auth secret storage, `shell.open`,
  the built-in skills dir) are *injected* by `apps/desktop/src/main` rather
  than imported, so the packages stay portable.
- `@codeswim/domain-unbiased` — "Sign in with Unbiased" (partner device
  flow that mints a Pareto key into opencode's auth store). Unbiased's rule:
  never re-send a token poll — a second poll after the 200 revokes the key.
  `npm run conformance --workspace @codeswim/domain-unbiased` runs their
  vendored kit (`conformance/`, kept verbatim); must stay 6/6.
- `@codeswim/coverage` — the diagram/source drift checker.
- `@codeswim/commit` — prompt-commit synthesis + triage.
- `@codeswim/whiteboard` — the talking whiteboard's pure core: line
  protocol, board model, guards, turn scheduler and narrator prompts
  ([architecture/whiteboard.md](architecture/whiteboard.md)).
- `@codeswim/harness` — the opencode plugin, session gate, tools, and
  prompts that get bundled into `out/harness/`.

Run everything from the repo root: `npm run dev` / `build` / `typecheck` /
`test` delegate to the desktop app or fan out across packages via Turbo.

## Commands

| | |
|---|---|
| `npm run dev` | electron-vite dev server with HMR (renderer) and rebuild (main/preload) |
| `npm run build` | typecheck + production build into `out/` |
| `npm run typecheck` | runs `typecheck:node` (main + preload) then `typecheck:web` (renderer) |
| `npm run lint` | eslint, cached |
| `npm run format` | prettier --write |
| `npm run build:mac` / `:win` / `:linux` | electron-builder packaging (fetches the speech models first) |
| `npm run fetch:models --workspace @codeswim/desktop` | the whiteboard's voice and speech-recognition models (~240 MB, gitignored) into `apps/desktop/models`; the app ships them, and dev uses them when present |

## Process layout

Standard Electron three-process app:

- **Main** ([apps/desktop/src/main/index.ts](apps/desktop/src/main/index.ts)) — owns the filesystem.
  Opens the folder picker, reads files, runs the chokidar watcher, spawns
  npm scripts via `child_process.spawn`, walks the directory tree. All IPC
  handlers (`pick-folder`, `read-file`, `list-markdown`, `list-tree`,
  `watch`/`unwatch`, `read-package-scripts`, `run-script`/`kill-script`)
  live here.

- **Preload** ([apps/desktop/src/preload/index.ts](apps/desktop/src/preload/index.ts) +
  [index.d.ts](apps/desktop/src/preload/index.d.ts)) — minimal `contextBridge`
  surface. Keeps `contextIsolation: true`, `nodeIntegration: false`.

- **Renderer** ([apps/desktop/src/renderer/src/App.tsx](apps/desktop/src/renderer/src/App.tsx)) — React app.
  Owns all UI state via reducer + context. Components consume `useStore()`.

The IPC contract lives in the `@codeswim/contract` package
([packages/contract/src/api.ts](packages/contract/src/api.ts)).
Treat it as a versioned interface — adding a method requires touching all
three processes.

## Renderer architecture

State is a single reducer in [state.tsx](apps/desktop/src/renderer/src/state.tsx),
exposed via context defined in [store.ts](apps/desktop/src/renderer/src/store.ts). The
two files are split so vite's fast-refresh works (only-components rule).

Views: `'diagram' | 'code' | 'output'`. The current file is tracked as a
relative posix path (`currentFile`). Breadcrumbs are a stack; navigation
pushes onto it, "back" / clicking a crumb pops to that point.

Path resolution lives in [path-utils.ts](apps/desktop/src/renderer/src/path-utils.ts).
Renderer code never deals in absolute paths — it converts to absolute only
at the IPC boundary, so diagrams stay portable.

## Mermaid integration

[DiagramView.tsx](apps/desktop/src/renderer/src/components/DiagramView.tsx) initializes
mermaid with `securityLevel: 'loose'` (required for `click ... call
navigate(...)` to invoke `window.navigate`). Mermaid is rendered
imperatively via `mermaid.render()`; `startOnLoad` is off.

The webview-style CSP in `apps/desktop/src/renderer/index.html` needs
`'unsafe-eval'` in `script-src` for mermaid loose mode and inline styles
allowed for the SVG output. If you tighten CSP, verify mermaid still
renders before shipping — there are *two* prior bugs of this exact shape.

## Markdown parser

[parse.ts](apps/desktop/src/renderer/src/parse.ts) extracts frontmatter (`name`,
`description`, `tags`) and mermaid blocks. It uses `js-yaml` rather than
`gray-matter` because gray-matter pulls in `Buffer` which Vite doesn't
polyfill cleanly.

The parser scans line-by-line (CommonMark-ish), handling 3+ backticks or
tildes and CRLF. **Don't replace it with a single regex** — the regex
version regressed twice. The shipped VS Code extension at
`codeswim-vscode` carries the same lesson in its CLAUDE.md.

## File watching

The chokidar watcher in main starts when the user picks a folder. It:
- Emits `file-changed` on every `.md` or non-`.md` change (renderer reloads
  if the changed file is currently displayed).
- Emits a debounced (200ms) `tree-changed` on add/unlink/addDir/unlinkDir
  so the file tree refreshes.
- Ignores `node_modules`, `dist`, `out`, `build`, `.git`, `.DS_Store`, and
  other ecosystems' vendored dependency trees (`.venv`, `venv`, `env`,
  `__pycache__`, `.tox`, `site-packages`, `vendor`, `target`, ... — see
  `TREE_IGNORED_DIRS` in `apps/desktop/src/main/index.ts`) — dotfiles/
  dot-directories that aren't one of those (`.env`, `.kiro`, `.vscode`,
  `.codeswim`, ...) are otherwise real project content and are
  watched/listed like anything else.

Debouncing matters — editors do multi-step writes (rename + write) that
fire several events within ~50ms.

## Script runner

[ScriptControls](apps/desktop/src/renderer/src/components/ScriptControls.tsx) shows a
dropdown of npm scripts; clicking Run spawns via `npm run <name>` with
`shell: true, detached: true`. The detached flag matters: `npm` itself
spawns subcommands (e.g. `tsx`, `vitest`), and we kill the whole process
group with `process.kill(-pid, 'SIGTERM')` on Stop. Without `detached`,
npm dies but its children leak.

The script names come from package.json — they're validated against the
parsed scripts before spawning, then shell-quoted defensively.

## Claude Code tab (IDE bridge)

The Claude Code tab runs the user's own `claude` CLI in a pty (they sign in
to it themselves — Codeswim never offers Claude login). Codeswim then acts
as "the IDE" for it, the way VS Code's Claude extension does:
[claude-ide.ts](apps/desktop/src/main/claude-ide.ts) runs a loopback
WebSocket MCP server, writes a `~/.claude/ide/<port>.lock` for the open
folder, and sets `CLAUDE_CODE_SSE_PORT` in the Claude tab's env so the CLI
auto-connects. The CLI then gets the code view's selection, and its proposed
edits (`openDiff`) show in the diff view with Accept/Reject — accept hands
the contents back and the CLI writes the file.

This protocol is **not published** — it was read off the shipped VS Code
extension and CLI (tool names, `FILE_SAVED`/`DIFF_REJECTED` results, the
auth header). If a CLI update stops connecting or diffs stop appearing,
re-check it against the current extension's `extension.js` first.
`claude-ide.test.ts` drives the server the way the CLI does.

## Browser panel

The globe in the header opens a right-side panel holding a real web page:
a sandboxed `WebContentsView` that main lays over the panel's viewport
([browser-host.ts](apps/desktop/src/main/browser-host.ts)). People and the
agent drive it through the `browser.*` commands, and the whiteboard narrator
points at it ([architecture/renderer.md](architecture/renderer.md#browser-panel)).
Three things that aren't obvious:

- The native view draws above all DOM. Nothing in the renderer can overlap
  it, so anything the panel needs to say shows only while the view is hidden.
- The page script ([browser-page.ts](apps/desktop/src/main/browser-page.ts))
  is a plain string run in an isolated world, not a `fn.toString()`. esbuild
  can inject helpers into a bundled function that don't exist inside the page.
- Playwright's window screenshots don't include the native view; capture the
  page's own `webContents` instead. A link a test clicks from script needs
  `executeJavaScript(code, true)` (a user gesture), or Chromium won't let
  Back return past it.

## Hooks

The bundled system prompt ([packages/harness/src/prompt/](packages/harness/src/prompt/))
is opinionated by design, but a user can extend it per-workspace without
touching the packaged app via `.codeswim/hooks.json`:

```json
{ "hooks": { "SessionStart": [{ "command": "cat .codeswim/mermaid-style.md" }] } }
```

Each `SessionStart` entry's stdout (on exit 0, within an optional `timeout`
ms, default 5000) is appended to the agent's system prompt for that session.
See [packages/harness/src/hooks.ts](packages/harness/src/hooks.ts) — parsing
follows the same tolerant-validation precedent as `.codeswim/runs.json`
(missing file, bad JSON, or a bad entry is silently skipped, never fatal),
and wiring is in `plugin.ts` via opencode's `experimental.chat.system.transform`
hook. There's no dedicated settings UI yet, same as `runs.json` — it's a
hand-edited file. `.codeswim/pronunciations.json` is the same kind of hand-edited file: it fixes
how the whiteboard's natural voice says product names
([architecture/whiteboard.md](architecture/whiteboard.md)).
This is the seam to extend if we add more hook events
(`PreToolUse`/`PostToolUse`) or a global (`~/.codeswim/`) scope later.

## Test fixture

[examples/sample-architecture/overview.md](examples/sample-architecture/overview.md) is a
hand-authored fictional project ("Triage" billing app, unrelated to this
repo's architecture) used to develop against. It's a real codeswim-style
hierarchy: `overview.md` → architecture/ → flows/ → src/. Use it as the
reference for what diagram authors *should* produce.

`codeswim-example` is a more elaborate version of the same
fixture with runnable code — point the navigator at it for end-to-end demos.

## Sandboxed environments

If `ELECTRON_RUN_AS_NODE=1` is set in the environment, Electron runs as
plain Node and `require('electron')` returns the path string (not the
namespace), which crashes startup at `electron.app.isPackaged`. This
shows up in CI sandboxes. Unset it before `npm run dev`.

## Don't

- Don't add an in-app diagram editor. The plan is explicit: this is a
  read-only navigator. Authoring happens in the user's editor; we just
  watch and re-render. The Whiteboard view isn't an exception: the narrator
  draws it, it's read-only for the human, and it is not a source of truth
  (mermaid stays the spec).
- Don't introduce a markdown renderer for prose more elaborate than
  what's needed for the diagram-page meta block. The rich markdown
  renderer lives in the VS Code extension's webview, not here.
- Don't add `Buffer` polyfills to the renderer. If a node-only library
  is required, do the work in main and IPC the result.
- Don't trust the GPU/network warnings on first dev boot — they're
  Electron complaining about a sandboxed shell environment, not bugs in
  the app.

## Related repos

- [`codeswim-vscode`](https://github.com/keithagroves/codeswim-vscode) — same idea as a
  VS Code extension; ships a `codeswim-coverage` CLI for checking
  diagram alignment with code.
- [`codeswim-example`](https://github.com/keithagroves/codeswim-example) — the demo
  codebase to navigate. Runnable: `npm run dev:api`.
