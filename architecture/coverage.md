---
name: Coverage
description: Diagram/source drift checker — walks the workspace, parses diagrams, reports broken links, orphans, uncovered sources, and mermaid errors.
tags: [coverage, mdd, tools]
---

Coverage is the feedback loop that makes MDD enforceable instead of
aspirational. It walks the workspace tree, reads every `.md` file,
extracts links and click handlers from mermaid blocks, and produces a
`CoverageReport` listing four kinds of drift: links that resolve to
nothing, diagrams not reachable from `overview.md`, source files not
referenced from any diagram, and mermaid blocks that fail to parse.
The report can also be formatted into a self-contained prompt the
[agent harness](./agent-harness.md) acts on.

```mermaid
flowchart TD
    Renderer((Renderer)) --> Run[run.ts<br/>runCoverage]
    Run -->|listTree IPC| Main[(Main process)]
    Run --> Filter[Filter ignored<br/>dirs & basenames]
    Filter --> ReadMD[Read .md contents]
    ReadMD --> Analyze[coverage.ts<br/>analyzeCoverage]
    Analyze --> Lint[mermaid-lint.ts]
    Analyze --> Report[CoverageReport]
    Report --> Prompt[buildSyncPrompt]
    Prompt -.->|chat sendMessage| Agent((Agent))

    click Renderer call navigate("../overview.md")
    click Filter call navigate("../apps/desktop/src/renderer/src/coverage/run.ts")
    click ReadMD call navigate("../apps/desktop/src/renderer/src/coverage/run.ts")
    click Report call navigate("../packages/coverage/src/coverage.ts")
    click Prompt call navigate("../apps/desktop/src/renderer/src/coverage/run.ts")
    click Run call navigate("../apps/desktop/src/renderer/src/coverage/run.ts")
    click Analyze call navigate("../packages/coverage/src/coverage.ts")
    click Lint call navigate("../packages/coverage/src/mermaid-lint.ts")
    click Main call navigate("./main-process.md")
    click Agent call navigate("./agent-harness.md")
```

## Notes

- Coverage runs in the renderer, not as a standalone CLI — it leans on the existing `listTree` and `readFile` IPC instead of duplicating filesystem code in a Node script.
- `coverage.ts` is pure: it takes `FileInfo[]` (path + content) and returns a report. That makes it trivially testable and reusable from anywhere.
- Non-markdown files are passed in with empty content; only diagrams need their text read.
- `buildSyncPrompt` deliberately doesn't prescribe fixes — the system prompt at `packages/harness/src/prompt/system.txt` and [mdd-fixes.md](../packages/harness/src/prompt/mdd-fixes.md) already encode the MDD rules, so the prompt just enumerates the drift and lets the agent pick the right fix per item.

## Source

- [apps/desktop/src/renderer/src/coverage/run.ts](../apps/desktop/src/renderer/src/coverage/run.ts) — workspace walker, file filter, prompt formatter.
- [packages/coverage/src/coverage.ts](../packages/coverage/src/coverage.ts) — the pure `analyzeCoverage` function and report types.
- [packages/coverage/src/mermaid-lint.ts](../packages/coverage/src/mermaid-lint.ts) — mermaid block syntax linting used inside the analyzer.
- [packages/coverage/src/index.ts](../packages/coverage/src/index.ts) — coverage package entry point.
