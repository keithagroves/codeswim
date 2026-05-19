<p align="center">
  <img src="codeswim.svg" alt="codeswim" width="240">
</p>

<p align="center">
  Browse a codebase as a hierarchy of mermaid diagrams.
  The diagrams are the spec; the code is what implements them.
</p>

---

## What it is

codeswim is a desktop app (Electron) that opens a folder and renders the markdown files inside it as a navigable diagram tree. Click a node in a diagram to drill into a child diagram or open the source file it represents. An AI agent panel keeps the diagrams aligned with the code as you change either side.

The thesis: as AI generates more code, humans should navigate architecture through intentional diagrams, not by reading generated implementation.

## The format

Every diagram lives in a markdown file with three parts: YAML frontmatter, a short prose paragraph, and exactly one mermaid block.

````markdown
---
name: API surface
description: HTTP routes exposed by the server and what they delegate to
tags: [api, http]
---

The server registers routes lazily on first request. Validation lives in
`validate.ts`; persistence lives in `db.ts`.

```mermaid
flowchart TD
    Server[server.ts] --> Validate[validate.ts]
    Validate --> DB[db.ts]
    Validate --> Bad["400 + err.message"]
    DB --> Created["201 + id"]

    click Server call navigate("../src/server.ts")
    click Validate call navigate("../src/validate.ts#L42-L78")
    click DB call navigate("../src/db.ts")
    click Bad call navigate("./errors.md")
    click Created call navigate("./errors.md")
```

## Source

- `../src/server.ts` — HTTP entry point, route table
- `../src/validate.ts` — request validation, returns typed errors
- `../src/db.ts` — Postgres queries
````

### Rules

| | |
|---|---|
| **One mermaid block per file** | The renderer only shows the first one. Extra blocks are ignored. |
| **Frontmatter is required** | `name`, `description`, `tags`. The description shows up in tooltips and tree views — make it specific. |
| **Every flowchart node needs a click handler** | `click NodeId call navigate("…")`. If a node has no obvious target, point at the parent diagram or `overview.md`. |
| **`click` is flowchart-only** | Sequence/class/state/ER diagrams don't support it. For those, put the links in the prose below as bullets. |
| **Line refs are encouraged** | `navigate("../src/server.ts#L25-L40")` jumps to and highlights those lines. `#L42` for a single line. 1-indexed, inclusive. |
| **Link to files, not directories** | `[migrations](../src/db/migrations/)` is broken — point at a representative file inside instead. |
| **Architecture docs have a Source section** | A bulleted list of the files the diagram covers with a one-line role each. Makes coverage auditable. |

### Click target resolution

- Targets ending in `.md` open as another diagram and push a breadcrumb.
- Everything else opens in the code pane.
- A target with `#L10-L22` opens the code pane and highlights that range.

### Layering convention

The only hard requirement is **`overview.md` at the workspace root** — coverage uses it as the entry for reachability. Beyond that, use whatever folder structure the project already has. For brand-new projects, the defaults are:

- `overview.md` — one diagram of the system's subsystems
- `architecture/<subsystem>.md` — structure diagrams with a Source list
- `flows/<flow>.md` — sequence/flowchart diagrams for specific request flows
- `decisions/adr-<n>-<slug>.md` — ADRs explaining *why*

## Running locally

```bash
npm install
npm run dev        # electron-vite dev server with HMR
```

## Building installers

```bash
npm run build:mac      # → dist/codeswim-<version>.dmg
npm run build:win      # → dist/codeswim-<version>-setup.exe
npm run build:linux    # → dist/codeswim-<version>.AppImage, .snap, .deb
```

A push of a `v*` tag triggers `.github/workflows/release.yml`, which builds on all three OSes and uploads to a GitHub draft release.

## Related

- [codeswim-vscode](https://github.com/keithagroves/codeswim-vscode) — same idea as a VS Code extension; ships a `codeswim-coverage` CLI for checking diagram/code alignment.
- [codeswim-example](https://github.com/keithagroves/codeswim-example) — a small demo codebase to point the navigator at.
