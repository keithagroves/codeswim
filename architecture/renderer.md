---
name: Renderer
description: React UI — state reducer, view switcher, side panels, mermaid rendering, markdown parsing.
tags: [renderer, react, ui]
---

The renderer owns everything the user sees. A single reducer in
`state.tsx` holds the workspace root, current file, view mode, and
breadcrumb stack; components consume it via `useStore()`. The chrome
(activity bar, file tree, breadcrumbs, side panels) wraps a view switch
that picks between diagram, code, output, and skills views based on what
the user navigated to. Mermaid is rendered with `securityLevel: 'loose'`
so that `click ... call navigate(...)` in user diagrams can invoke
`window.navigate` and push onto the breadcrumb stack.

```mermaid
flowchart TD
    Entry[main.tsx] --> AppRoot[App.tsx]
    AppRoot --> State[(state.tsx<br/>reducer)]
    Store[store.ts<br/>useStore] -.-> State
    AppRoot --> Activity[ActivityBar]
    AppRoot --> Tree[FileTree]
    AppRoot --> Crumbs[Breadcrumbs]
    AppRoot --> Search[SearchPanel]
    AppRoot --> SkillsP[SkillsPanel]
    AppRoot --> Toasts
    AppRoot --> View{view}
    View -->|diagram| Diagram[DiagramView]
    View -->|code| Code[CodeView]
    View -->|read| Read[ReadView]
    View -->|output| Output[ScriptOutput]
    View -->|skills| SkillsV[SkillsView]
    Diagram --> Parse[parse.ts]
    Read --> Parse
    Diagram -->|click navigate| State
    Diagram --> ErrBanner[MermaidErrorBanner]
    Read --> Prose[MarkdownProse]
    AppRoot --> ScriptCtl[ScriptControls]
    State --> PathUtil[path-utils.ts]

    click Entry call navigate("../src/renderer/src/main.tsx")
    click AppRoot call navigate("../src/renderer/src/App.tsx")
    click State call navigate("../src/renderer/src/state.tsx")
    click Store call navigate("../src/renderer/src/store.ts")
    click Parse call navigate("../src/renderer/src/parse.ts")
    click PathUtil call navigate("../src/renderer/src/path-utils.ts")
    click Diagram call navigate("../src/renderer/src/components/DiagramView.tsx")
    click Code call navigate("../src/renderer/src/components/CodeView.tsx")
    click Read call navigate("../src/renderer/src/components/ReadView.tsx")
    click Output call navigate("../src/renderer/src/components/ScriptOutput.tsx")
    click SkillsV call navigate("../src/renderer/src/components/SkillsView.tsx")
    click Activity call navigate("../src/renderer/src/components/ActivityBar.tsx")
    click Tree call navigate("../src/renderer/src/components/FileTree.tsx")
    click Crumbs call navigate("../src/renderer/src/components/Breadcrumbs.tsx")
    click Search call navigate("../src/renderer/src/components/SearchPanel.tsx")
    click SkillsP call navigate("../src/renderer/src/components/SkillsPanel.tsx")
    click Toasts call navigate("../src/renderer/src/components/Toasts.tsx")
    click ScriptCtl call navigate("../src/renderer/src/components/ScriptControls.tsx")
    click ErrBanner call navigate("../src/renderer/src/components/MermaidErrorBanner.tsx")
    click Prose call navigate("../src/renderer/src/components/MarkdownProse.tsx")
```

## Notes

- `state.tsx` and `store.ts` are split so Vite fast-refresh works — the `react-refresh/only-export-components` rule won't accept a single file exporting both a Provider and hooks.
- `path-utils.ts` keeps the renderer working in POSIX-relative paths; absolute paths only appear at the IPC boundary so diagrams stay portable across machines.
- `parse.ts` extracts frontmatter via `js-yaml` (not `gray-matter`, which pulls in `Buffer` the renderer can't polyfill cleanly) and scans line-by-line for fenced mermaid blocks — don't replace it with a single regex.
- `DiagramView.tsx` calls `mermaid.render()` imperatively and re-renders on `file-changed` events emitted from the watcher.
- The chat UI lives separately — see [Agent harness](./agent-harness.md).

## Source

### Entry & state

- [src/renderer/src/App.tsx](../src/renderer/src/App.tsx) — top-level layout, view switch, panel wiring.
- [src/renderer/src/state.tsx](../src/renderer/src/state.tsx) — the reducer, action types, default state.
- [src/renderer/src/store.ts](../src/renderer/src/store.ts) — React context + `useStore()` hook.
- [src/renderer/src/parse.ts](../src/renderer/src/parse.ts) — frontmatter + mermaid block extractor.
- [src/renderer/src/path-utils.ts](../src/renderer/src/path-utils.ts) — POSIX path normalization and resolution.
- [src/renderer/src/skill-frontmatter.ts](../src/renderer/src/skill-frontmatter.ts) — tiny helpers for parsing the `name`/`description` fields the Skills view shows.

### Components

- [ActivityBar.tsx](../src/renderer/src/components/ActivityBar.tsx) — left-rail tab switcher.
- [FileTree.tsx](../src/renderer/src/components/FileTree.tsx) — workspace file tree.
- [Breadcrumbs.tsx](../src/renderer/src/components/Breadcrumbs.tsx) — navigation stack as crumbs.
- [DiagramView.tsx](../src/renderer/src/components/DiagramView.tsx) — renders one mermaid block and wires `window.navigate`.
- [MermaidErrorBanner.tsx](../src/renderer/src/components/MermaidErrorBanner.tsx) — surfaces parse/render failures inline.
- [CodeView.tsx](../src/renderer/src/components/CodeView.tsx) — CodeMirror viewer for source files.
- [ReadView.tsx](../src/renderer/src/components/ReadView.tsx) — prose-mode markdown viewer for diagram pages.
- [MarkdownProse.tsx](../src/renderer/src/components/MarkdownProse.tsx) — markdown renderer used inside read view and skills view.
- [SearchPanel.tsx](../src/renderer/src/components/SearchPanel.tsx) — workspace search.
- [SkillsPanel.tsx](../src/renderer/src/components/SkillsPanel.tsx) — left-rail list of available skills.
- [SkillsView.tsx](../src/renderer/src/components/SkillsView.tsx) — full-pane skill markdown viewer.
- [ScriptControls.tsx](../src/renderer/src/components/ScriptControls.tsx) — npm script dropdown + run/stop.
- [ScriptOutput.tsx](../src/renderer/src/components/ScriptOutput.tsx) — stdout/stderr stream for the running script.
- [Toasts.tsx](../src/renderer/src/components/Toasts.tsx) — transient notifications.
