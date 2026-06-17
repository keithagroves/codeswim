---
name: Coverage Runner
description: Renderer-side workspace walker that feeds file trees into the pure coverage analyzer and formats the report as an agent prompt.
tags: [coverage, mdd, renderer]
---

## Purpose

Wraps the pure `analyzeCoverage` function ([`coverage.ts`](./coverage.ts.md)) with the filesystem calls the renderer needs — listing the workspace tree via IPC, reading markdown files, and filtering out noise (ignored dirs, lockfiles, config files). The result is either returned as a `CoverageReport` for the UI or formatted into a prompt the [agent harness](../../../../../architecture/agent-harness.md) acts on.

## Responsibilities

- Walk the workspace tree (via `window.api.listTree`) and flatten it into a list of file paths, skipping subtrees under ignored directories (`node_modules`, `dist`, `.git`, etc.).
- Read the content of every `.md`/`.markdown` file; skip unreadable ones gracefully.
- Pass non-markdown file paths into the analyzer with empty content — the analyzer only needs their path to exist in the file set.
- Filter out common non-architectural basenames (`LICENSE`, `CHANGELOG.md`, `.gitignore`, lockfiles, config dotfiles) so they never appear in the coverage report.
- Call `analyzeCoverage` and return its report.
- Format a report into a self-contained Markdown prompt (`buildSyncPrompt`) that teaches the agent what drift exists (broken links, orphan diagrams, uncovered sources, mermaid issues) and lets it pick the right fix per item, since the [system prompt](../../../../../packages/harness/src/prompt/system.txt) and [`mdd-fixes.md`](../../mdd-fixes.md) already encode the repair rules.

## Inputs and outputs

**Inputs:**
- `rootPath` — absolute POSIX path to the workspace root (from the store, forwarded via IPC by the main process).

**Outputs:**
- `CoverageReport` — the structured result from `analyzeCoverage`: broken links, orphan diagrams, uncovered sources, mermaid issues, and per-file link/click-handler data.
- `buildSyncPrompt(report)` — a formatted Markdown string the agent ingests as drift instructions.

## Control and data flow

1. `runCoverage(rootPath)` requests the full file tree via `listTree IPC`.
2. `flatten()` walks the returned `TreeNode[]` recursively, dropping ignored-directory subtrees.
3. For each file, the path is relativized against `rootPath`; non-markdown files are added with `content: ''`; markdown files are read via `readFile IPC` and paired with their relative path.
4. The assembled `FileInfo[]` is handed to `analyzeCoverage` (in [`coverage.ts`](./coverage.ts.md)), which produces the report.
5. `buildSyncPrompt` serializes each drift category into a section the agent can parse and act on.

```
[UI/Agent] → runCoverage(rootPath)
           → listTree IPC → flatten + filter
           → readFile IPC (for .md files)
           → analyzeCoverage(files)
           → CoverageReport → UI or buildSyncPrompt → Agent
```

## Dependencies and side effects

- Imports `joinPosix` / `toPosix` from [`path-utils.ts`](../../path-utils.ts) for POSIX path normalization.
- Calls `analyzeCoverage` from [`coverage.ts`](./coverage.ts.md) — the pure core.
- Calls `window.api.listTree` and `window.api.readFile` IPC methods defined in the [preload bridge](../../../../../architecture/preload.md) and backed by [main process](../../../../../architecture/main-process.md) handlers.
- No filesystem writes. No mutation of application state.

## Failure modes

- **Unreadable diagram file** — caught by try/catch around `readFile`; the file is simply omitted from the input set. The analyzer will not see its links, which may produce false positives in the report (missing links from an author-ignored diagram). This is deliberate — a diagram that can't be read should not block coverage.
- **`listTree` IPC failure** — propagates as an unhandled rejection. The caller is expected to handle this (typically the UI or agent session swallows it as "coverage unavailable").
- **Non-reachable root** — if `rootPath` is wrong or the workspace was closed, `listTree` returns an empty tree, producing a coverage report with no diagrams and all files as uncovered — correct but noisy.

## Related diagrams and decisions

- [Coverage diagram](../../../../../architecture/coverage.md) — shows `run.ts` as the entry point (`runCoverage` node) that feeds into the analyzer and the prompt builder.
- [Prompt Commits diagram](../../../../../architecture/prompt-commits.md) — reuses `buildSyncPrompt` as the MDD gate before commit synthesis. The `Cov` node in that diagram is the coverage `run.ts` module.
- [Prompt Commits](../../../../../architecture/prompt-commits.md#thesis) — the decision to run coverage as a gate before commit synthesis, so diagrams and code land together.
