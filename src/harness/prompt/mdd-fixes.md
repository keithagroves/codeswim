# Reading codeswim coverage reports

Coverage runs via the `codeswim-coverage` CLI (or the in-app "Check coverage"
button) and reports three categories of drift. Each maps to a specific
fix — apply them by editing the diagram(s), not the code.

## The seven rules (recap)

1. **Coverage** — every source file is referenced by at least one diagram.
2. **Reachability** — every diagram is reachable from `overview.md`.
3. **File links, not directory links** — `[a.ts](../src/a.ts)` is valid; `[src/](../src/)` is broken.
4. **Frontmatter on every diagram** — `name`, `description`, `tags`.
5. **Navigable mermaid nodes** — `click NodeId call navigate("../path/to/file.ts")`.
6. **"Source" section per architecture diagram** — bulleted list of files with a one-line role each.
7. **Layering** — `overview.md` at root is the only required file; the rest is convention. Adopt whatever folder structure the project already uses (e.g. `architecture/`, `subsystems/`, `flows/`, `arch/`, or flat). Defaults for empty projects: `overview.md` → `architecture/*.md` → `flows/*.md`; ADRs in `decisions/adr-*.md`.

## Drift table

| Coverage report               | Cause                          | Fix                                                                                                                |
| ----------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| **Broken link to a directory** | Rule 3 violation               | Replace with a link to a specific file inside the directory.                                                       |
| **Broken link to moved file** | Source moved without doc update | Update the link; check whether the file's role in the diagram still makes sense.                                   |
| **Orphan diagram**            | Rule 2 violation               | Add a markdown link from `overview.md` (or another already-reachable diagram) pointing at it.                       |
| **Uncovered source file**     | Rule 1 violation               | Add a reference in the most relevant existing architecture doc — usually under its "Source" list.                   |

For uncovered files, prefer extending an existing diagram over creating
a new one. Cross-cutting files (env, logger, config) belong in
`overview.md` under a conventions or setup bullet. Test files belong in
a Testing section in `overview.md`. Only create a new diagram when a
genuinely new subsystem appears.

## When code changes

When you edit, add, move, or delete a source file, update any diagram
that references it in the same change:

- **Renamed/moved** — grep for the old path in `*.md` and update every link.
- **New** — find the diagram whose subsystem owns it; add a Source entry, and add a `click ... call navigate(...)` if it's a node in the flow.
- **Deleted** — remove all references; if it was a node in a mermaid block, remove that node and any edges into it.
- **New subsystem** — create a subsystem diagram in whatever folder the project uses for them (defaulting to `architecture/<name>.md` if there's no precedent) with frontmatter, a mermaid diagram, and a Source list. Add a `click` handler from `overview.md` pointing to it.

If you can't tell which diagram owns a file, ask before guessing —
putting a file under the wrong diagram is worse than leaving it
temporarily uncovered.

## Verifying

Don't claim alignment is restored on the basis of edits alone — run
codeswim coverage again and confirm the report shows zero broken
links, zero orphans, and zero uncovered source files before considering
the task done.
