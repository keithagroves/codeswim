# Codeswim IDE — Information Architecture Map

*Descriptive inventory of what the desktop app does today and how it is surfaced. No recommendations — this is the baseline we'll run user stories against.*

Scope: the Electron renderer (`apps/desktop/src/renderer`) plus the domain packages it consumes. All file references are clickable and verifiable.

---

## Capability summary table

| Capability | Code location | Current surface(s) | Build status | Interaction mode | Split-representation? |
|---|---|---|---|---|---|
| **Agent chat** (opencode-backed AI) | [ChatPanel.tsx](apps/desktop/src/renderer/src/components/ChatPanel.tsx), [state.tsx](apps/desktop/src/renderer/src/state.tsx), [agent.ts](apps/desktop/src/renderer/src/agent.ts) | Left panel (`agent` section) | Built | Active workspace *(candidate: also persistent)* | **Yes** — one chat panel, but many features (Sync, PR review, Mermaid fix, explanation, new-run) inject prompts into it from elsewhere |
| **Code diagrams** (mermaid navigator) | [DiagramView.tsx](apps/desktop/src/renderer/src/components/DiagramView.tsx), [parse.ts](apps/desktop/src/renderer/src/parse.ts) | Main window (`navigator`/"Explore" view) | Built | Active workspace | No |
| **Source explanation viewer** (read view) | [ReadView.tsx](apps/desktop/src/renderer/src/components/ReadView.tsx), [MarkdownProse.tsx](apps/desktop/src/renderer/src/components/MarkdownProse.tsx) | Main window (`read` view) | Built | Active workspace | No |
| **Plans / Kanban board** | [KanbanView.tsx](apps/desktop/src/renderer/src/components/KanbanView.tsx), [domain-kanban](packages/domain-kanban/src/kanban.ts) | Main window ("Plan" view) | Built (GitHub Projects sync partial) | Active workspace | No |
| **File tree** | [FileTree.tsx](apps/desktop/src/renderer/src/components/FileTree.tsx) | Left panel (`files` section) | Built | Persistent context | No |
| **Search** (file-name fuzzy) | [SearchPanel.tsx](apps/desktop/src/renderer/src/components/SearchPanel.tsx) | Left panel (`search` section) | Built (filename-only; no content search) | On-demand | No |
| **Skills manager** | [SkillsPanel.tsx](apps/desktop/src/renderer/src/components/SkillsPanel.tsx), [SkillsView.tsx](apps/desktop/src/renderer/src/components/SkillsView.tsx) | Left panel (`tools`→Skills tab) **+** main window (editor) | Built | On-demand / Active workspace | **Yes** — index in rail, editor in main window (intentional master/detail; shared state) |
| **Agent instructions / context** (AGENTS.md + system prompts) | [SkillsPanel.tsx](apps/desktop/src/renderer/src/components/SkillsPanel.tsx) (Context tab), [SkillsView.tsx](apps/desktop/src/renderer/src/components/SkillsView.tsx), [agents-doc.ts](packages/domain-skills/src/agents-doc.ts) | Left panel (`tools`→Context tab) **+** main window (editor) | Built | On-demand | **Yes** — same rail/main split as Skills |
| **MCP servers** | [McpView.tsx](apps/desktop/src/renderer/src/components/McpView.tsx), [SkillsPanel.tsx](apps/desktop/src/renderer/src/components/SkillsPanel.tsx) (MCP tab) | Left panel (`tools`→MCP tab) **+** main window | **Stubbed** ("coming soon" copy in both places) | On-demand | **Yes** — two independent placeholders (see anomalies) |
| **Commit / Sync (git)** | [GitPanel.tsx](apps/desktop/src/renderer/src/components/GitPanel.tsx), [domain-git](packages/domain-git/src/git.ts), [commit](packages/commit/src/index.ts) | Left panel (`git` section) + activity-bar badge; diffs render in main window | Built | Active workspace + Ambient (badge) | Partial — diff opens in main window |
| **Diff viewer** | [DiffView.tsx](apps/desktop/src/renderer/src/components/DiffView.tsx) | Main window (transient `diff` view) | Built | On-demand | Shared by git files + PRs |
| **Pull requests** | [PullRequestsPanel.tsx](apps/desktop/src/renderer/src/components/PullRequestsPanel.tsx), [domain-github/pull-requests.ts](packages/domain-github/src/pull-requests.ts) | Left panel (`pulls` section) + activity-bar badge; diffs/reviews in main + agent | Built | Active workspace + Ambient (badge) | Partial — spills into diff viewer + agent chat |
| **Team chat** (room chat) | [RoomChatPanel.tsx](apps/desktop/src/renderer/src/components/RoomChatPanel.tsx), [chat/connection.ts](apps/desktop/src/renderer/src/chat/connection.ts), [domain-github/room.ts](packages/domain-github/src/room.ts) | Left panel (`chat` section) | Built (needs git remote + GitHub auth) | Persistent context / Ambient | No |
| **Terminal** | [TerminalPanel.tsx](apps/desktop/src/renderer/src/components/TerminalPanel.tsx) | Left panel (`terminal` section) | Built (ghostty-web pty) | Active workspace | **Yes (self)** — two instances: `terminal` + `claude` sections share the component |
| **Claude Code (embedded CLI)** | [TerminalPanel.tsx](apps/desktop/src/renderer/src/components/TerminalPanel.tsx) with `command="claude"` | Left panel (`claude` section) | Built | Active workspace | **Yes** — a second agent surface parallel to Agent chat *and* a second terminal |
| **Script / run controls** | [ScriptControls.tsx](apps/desktop/src/renderer/src/components/ScriptControls.tsx), [ScriptOutput.tsx](apps/desktop/src/renderer/src/components/ScriptOutput.tsx) | Header (dropdown + run chip) + main window (`output` view) | Built | On-demand + Ambient (run chip) | Partial — control in header, output in main |
| **Diagram/source coverage (Sync audit)** | [coverage/run.ts](apps/desktop/src/renderer/src/coverage/run.ts), [coverage](packages/coverage/src/coverage.ts) | Invoked from Commit panel / toast; results routed to agent chat | Built | On-demand → feeds Agent | Yes — no surface of its own; borrows chat + toast |
| **Navigation (breadcrumbs, back/fwd/home, recents)** | [Breadcrumbs.tsx](apps/desktop/src/renderer/src/components/Breadcrumbs.tsx), `NavControls` in [App.tsx](apps/desktop/src/renderer/src/App.tsx), `StartScreen` | Path-bar (below header) + start screen | Built | Persistent context | No |
| **Toasts** | [Toasts.tsx](apps/desktop/src/renderer/src/components/Toasts.tsx) | Overlay (bottom) | Built | Ambient/notification | No |
| **Activity-bar badges** | [ActivityBar.tsx](apps/desktop/src/renderer/src/components/ActivityBar.tsx), `refreshChangeCount`/`refreshOpenPrCount` in [state.tsx](apps/desktop/src/renderer/src/state.tsx) | Activity bar (git + pulls counts) | Built | Ambient/notification | No |

---

## Per-capability detail

### Agent chat
The primary AI surface. Connects to a spawned opencode harness (`window.api.startHarness`), streams message parts (text/reasoning/tool), manages sessions, and renders a pending-question prompt inline. Lives in the `agent` left-panel section ([App.tsx:80](apps/desktop/src/renderer/src/App.tsx#L80)). All chat state (`chatMessages`, `chatStatus`, `sessions`, `currentSessionId`, `pendingQuestion`) is in the central reducer ([state.tsx:82-88](apps/desktop/src/renderer/src/state.tsx#L82-L88)).

The agent also **drives the main window**: `open_file`/`set_view` tools return `codeswim_action` metadata that `applyViewAction` dispatches into navigation ([state.tsx:1325](apps/desktop/src/renderer/src/state.tsx#L1325)). Conversely, many other capabilities push prompts *into* the chat: Sync ([syncDiagrams](apps/desktop/src/renderer/src/state.tsx#L1093)), PR review ([reviewPullRequest](apps/desktop/src/renderer/src/state.tsx#L1121)), Mermaid-error fix ([MermaidErrorBanner.tsx](apps/desktop/src/renderer/src/components/MermaidErrorBanner.tsx)), "create source explanation" ([state.tsx:622](apps/desktop/src/renderer/src/state.tsx#L622)), and "add a run" ([ScriptControls.tsx](apps/desktop/src/renderer/src/components/ScriptControls.tsx)). It also runs *ephemeral* sessions for commit-message and Sync-plan synthesis that deliberately never appear in the visible chat ([state.tsx:1196](apps/desktop/src/renderer/src/state.tsx#L1196), [state.tsx:1219](apps/desktop/src/renderer/src/state.tsx#L1219)).

### Code diagrams (navigator / "Explore")
Renders mermaid blocks from the current markdown file; `click ... call navigate(...)` edges call `window.navigate` to drive breadcrumb navigation (mermaid `securityLevel: 'loose'`). This is the app's thesis surface. Shown in the main window when `workspaceView === 'navigator'` and the current file is `.md` ([App.tsx:245](apps/desktop/src/renderer/src/App.tsx#L245)).

### Source explanation viewer (read view)
For non-`.md` source leaves the app shows a companion explanation document instead of the raw file (`readSourceExplanation`, [state.tsx:819](apps/desktop/src/renderer/src/state.tsx#L819)). If the explanation is missing, `sourceExplanationExists` is false and the "Open in editor"/"create explanation" affordances apply. Uses `MarkdownProse` with collapsible `## Source` manifest.

### Plans / Kanban ("Plan")
Full board with columns, cards, priorities, labels, and card→file deep links (`linkedPath` navigates the navigator). Selected via the header "Plan" tab (`workspaceView === 'kanban'`, [App.tsx:231](apps/desktop/src/renderer/src/App.tsx#L231)). Cards can also be created by the agent via the `kanban_add` tool ([kanban-add.ts](packages/harness/src/tool/kanban-add.ts)). GitHub Projects sync exists in the contract (`KanbanGitHubConfig`, owner/projectNumber) and UI (`GitHubDraft`) but appears partial.

### File tree
Recursive tree from `window.api.listTree`, auto-expands to the current file, refreshes on watcher `tree-changed`. Clicking a file navigates. Left panel `files` section.

### Search
Client-side **filename** fuzzy match over the flattened tree ([SearchPanel.tsx:19](apps/desktop/src/renderer/src/components/SearchPanel.tsx#L19)) — biases name matches over path matches, caps at 100. No file-content search. Left panel `search` section.

### Skills manager
Two-part master/detail. The **rail** (`SkillsPanel`, `tools` section, Skills tab) lists skills grouped by scope (built-in system prompts / workspace `.agents/skills` / global `~/.agents/skills`), expandable to show each skill's file tree. The **main window** (`SkillsView`) is the editor/renderer for the selected file, with rendered/raw toggle, save, and read-only for built-ins. State shared via `state.currentSkill` + `state.toolsTab`. Note: when `activeSection === 'tools'` the main window is *replaced* by `SkillsView`/`McpView` ([App.tsx:220](apps/desktop/src/renderer/src/App.tsx#L220)), so opening Tools overrides the navigator/board entirely.

### Agent instructions / context
The "Context" sub-tab of the Tools section surfaces workspace + global `AGENTS.md` (edited through the agents-doc IPC) and the built-in system prompts group ([SkillsPanel.tsx:416-425](apps/desktop/src/renderer/src/components/SkillsPanel.tsx#L416-L425)). Editing happens in the same main-window `SkillsView` used for skills (`currentSkill.kind === 'agents'`).

### MCP servers
**Stubbed.** Two separate placeholders: the rail's MCP tab renders inline "coming soon" copy ([SkillsPanel.tsx:406-415](apps/desktop/src/renderer/src/components/SkillsPanel.tsx#L406-L415)) and the main window renders `McpView` ([McpView.tsx](apps/desktop/src/renderer/src/components/McpView.tsx)) with different "coming soon" copy. No backend.

### Commit / Sync (git)
The `git` section runs a bespoke **Sync** state machine (idle→working→blocked/plan→done/error, [GitPanel.tsx:29](apps/desktop/src/renderer/src/components/GitPanel.tsx#L29)) that deliberately hides staged/unstaged: audit coverage → agent triage plan → grouped commits. Has changes/history tabs. Clicking a changed file opens the **main-window diff viewer** (`showFileDiff`). An activity-bar badge shows unique changed-path count ([state.tsx:985](apps/desktop/src/renderer/src/state.tsx#L985)).

### Diff viewer
Transient main-window view (`view === 'diff'`) that overrides navigator/board ([App.tsx:228](apps/desktop/src/renderer/src/App.tsx#L228)). Renders a raw unified diff with per-line coloring. Shared by git file diffs and PR diffs (`prDiffLabel` doubles as the dedup key).

### Pull requests
Lists open/closed/all PRs via `gh`/GitHub API. Actions: view diff (→ main-window diff viewer, `showPullRequestDiff`), review (→ pushes a prompt + diff into agent chat, `reviewPullRequest`), merge. Activity-bar badge shows open-PR count. Left panel `pulls` section.

### Team chat (room chat)
Per-workspace shared chat room derived from the git remote ([domain-github/room.ts](packages/domain-github/src/room.ts)); requires a shared remote and GitHub auth (device-flow sign-in handled in-panel). Messages can deep-link to files. Left panel `chat` section (People icon, distinct from the Agent bubble).

### Terminal
Real pty via ghostty-web WASM, multi-tab. The `terminal` section is kept mounted (display:none when hidden) so switching sections doesn't kill live shells ([App.tsx:63-101](apps/desktop/src/renderer/src/App.tsx#L63-L101)). Toggled with `Ctrl+\``.

### Claude Code (embedded CLI)
The **same** `TerminalPanel` component, spawned with `command="claude"` under a separate `claude` section ([App.tsx:94-101](apps/desktop/src/renderer/src/App.tsx#L94-L101)). It is simultaneously (a) a second AI-agent surface alongside Agent chat and (b) a second terminal instance.

### Script / run controls
Header dropdown lists npm scripts + custom `.codeswim/runs.json` entries; Run spawns a detached process group. Output streams to the main-window `output` view; while running, a "run chip" in the header links back to output ([App.tsx:160-169](apps/desktop/src/renderer/src/App.tsx#L160-L169)). "Add a run" delegates to the agent.

### Coverage / Sync audit
No surface of its own. `runCoverage` computes broken links / orphan diagrams / uncovered sources / mermaid issues; results either toast "clean" or are handed to the agent as a prompt, or block the Commit Sync flow.

### Navigation
Breadcrumb stack + browser-style back/forward/home in the path-bar (below the header, [App.tsx:179](apps/desktop/src/renderer/src/App.tsx#L179)), recents on the start screen, and native File-menu Open/New/Recent. History is a `breadcrumbs`/`forward` stack pair in state.

### Toasts & badges
Toasts are transient bottom overlays. Activity-bar badges (git changes, open PRs) are fetched centrally in the store regardless of whether the owning panel is mounted, so counts show even when never opened.

---

## Panel / layout system

Layout is a **hand-rolled fixed three-region shell**, not a docking framework. Owned by `Shell`/`SidePanel` in [App.tsx](apps/desktop/src/renderer/src/App.tsx) and driven by the central reducer in [state.tsx](apps/desktop/src/renderer/src/state.tsx).

- **Structure:** `activity-bar` (far left, always visible) → `side-panel` (one section at a time) → `main-column` (header + optional path-bar + content). Defined at [App.tsx:362-386](apps/desktop/src/renderer/src/App.tsx#L362-L386).
- **Left panel:** exactly one `Section` active at a time (`agent | files | search | tools | git | pulls | terminal | claude | chat`), or `null` = collapsed. There is **no** second/right dock and **no** simultaneously-visible panels — sections are mutually exclusive tabs on a single rail. Selection via `toggleActiveSection` (click active icon = collapse; [state.tsx:346](apps/desktop/src/renderer/src/state.tsx#L346)).
- **Resizable, not floating:** the side panel is drag-resizable 180–700px (`SidePanel.onResizeStart`, persisted to `localStorage` `codeswim:sidePanelWidth`). Nothing floats or tears off; there are no draggable/dockable windows. The only drag interaction besides resize is **reordering activity-bar icons** (persisted `codeswim:activityOrder`, [ActivityBar.tsx:192-220](apps/desktop/src/renderer/src/components/ActivityBar.tsx#L192-L220)).
- **Main window** is single-slot, resolved by `Body()` ([App.tsx:217-252](apps/desktop/src/renderer/src/App.tsx#L217-L252)) in priority order: Tools override → `output` → `diff` → kanban → empty/diagram/read. The header's Explore/Plan tabs switch `workspaceView`; transient `output`/`diff` views stack on top and restore `prevView` on close.
- **Keep-alive quirk:** terminal + claude sections stay mounted (hidden via `display:none`) once opened, because unmounting would kill their pty.
- **Modals/drawers:** none in the classic sense. Chat settings is an inline toggle (`chatSettingsOpen`); the agent pending-question prompt renders inline in the chat; toasts are the only overlay.
- **Visibility toggles:** activity-bar click, `toggleSidebar` (collapse↔last section), `Ctrl+\`` (terminal), header tabs (Explore/Plan). No command palette.

---

## Interaction-mode classification

| Capability | Mode | Justification |
|---|---|---|
| File tree | Persistent context | Always-available orientation, glanceable, no completion. |
| Navigation (breadcrumbs/back/fwd) | Persistent context | Ambient wayfinding shown alongside every navigator view. |
| Team chat | Persistent context *(+ ambient)* | Meant to stay open as background awareness of collaborators. |
| Code diagrams (navigator) | Active workspace | The focused task surface — the app's reason to exist. |
| Source explanation viewer | Active workspace | Focused reading surface, shares the main window. |
| Plans / Kanban | Active workspace | A full main-window work surface you act within. |
| Terminal | Active workspace | Focused interactive surface occupying the panel. |
| Search | On-demand | Summoned to jump, then dismissed. |
| Skills / Context editor | On-demand | Opened to inspect/edit, then closed; overrides main window. |
| MCP servers | On-demand | Would be summoned config (currently stub). |
| Diff viewer | On-demand | Opened from a file/PR click, closed back to prior view. |
| Script controls | On-demand *(+ ambient chip)* | Launched deliberately; run chip is the ambient part. |
| Coverage / Sync audit | On-demand | Triggered, produces a result, dismisses into chat/toast. |
| Toasts | Ambient/notification | Transient signal that something happened. |
| Activity-bar badges | Ambient/notification | Passive count that something changed (git/PRs). |

### Split-representation candidates (need two modes)

1. **Agent chat** — lives as a left-rail "Active workspace" surface, but functionally behaves as **persistent context** (it drives the main window, receives injected prompts from six other features, and runs invisible background sessions). It is simultaneously a focused surface and a cross-cutting service. Strongest split candidate.
2. **Claude Code vs Agent chat** — two AI surfaces on the same rail with no shared state; a user "talking to the agent" could mean either.
3. **Terminal vs Claude** — one component, two rail slots, two personas; ambiguous which "terminal" means.
4. **Commit/Sync and Pull requests** — each is an Active-workspace panel *and* an Ambient badge, *and* spills into the main-window diff viewer and/or agent chat. Three surfaces per capability.
5. **Skills / Context / MCP** — rail index (persistent-ish) + main-window editor (active), the classic master/detail split. Intentional and shares state, unlike #1–#4.

---

## State & data flow

Nearly all UI state is a **single reducer** in [state.tsx](apps/desktop/src/renderer/src/state.tsx), exposed through one context ([store.ts](apps/desktop/src/renderer/src/store.ts)). Cross-surface sharing is therefore the norm, which is where duplicate-surface issues surface.

| Capability | Reads | Writes | Shared across surfaces? |
|---|---|---|---|
| Agent chat | `chatMessages`, `chatStatus`, `sessions`, `currentSessionId`, `pendingQuestion`, `chatSettingsOpen` | same, via `sendChat`/session thunks | **Yes** — six other features write prompts here; agent tools write `currentFile`/`workspaceView` |
| Navigator / Read | `currentFile`, `currentDocumentPath`, `fileContents`, `view`, `breadcrumbs`, `forward`, `sourceExplanationExists` | via `navigateAbsolute`/`goBack`/`popTo` | **Yes** — file tree, search, chat, kanban cards, diagram clicks all write it |
| Kanban | `KanbanBoard` (IPC-loaded, local to panel) + `state.rootPath`/`tree` | board IPC; `linkedPath`→navigation | Partial — agent `kanban_add` writes the same board file |
| File tree | `state.tree`, `currentFile` | navigation | Yes (read by search + chat path-resolution too) |
| Search | `state.tree` | navigation | Read-only consumer |
| Skills/Context/MCP | `currentSkill`, `toolsTab`, `activeSection`; file content local to `SkillsView` | `setCurrentSkill`, `setToolsTab` | **Yes** — rail + main window coordinate through shared state |
| Commit/Sync | `GitStatus`/history (local), `changeCount`, coverage report; ephemeral agent sessions | `changeCount`, commits, `showFileDiff`→`diff*` | **Yes** — badge, diff viewer, agent all touched |
| Diff viewer | `diffPath`, `diffContent`, `diffLoading`, `prevView` | `hideDiff` | **Yes** — written by both git and PR flows (path = dedup key) |
| Pull requests | list (local), `openPrCount` | `openPrCount`, `showPullRequestDiff`→`diff*`, `reviewPullRequest`→chat | **Yes** — badge + diff + chat |
| Team chat | room identity/messages (local to panel via `useRoomChat`) | messages; `navigateAbsolute` on link click | Mostly isolated (writes navigation) |
| Terminal / Claude | `activeSection`, `rootPath` | pty (outside React state) | Isolated (kept-alive DOM) |
| Scripts | `runs`, `runningScript`, `view`/`prevView` | `script-*` actions, `view: 'output'` | **Yes** — header control + main output + run chip |
| Navigation/breadcrumbs | `breadcrumbs`, `forward`, `currentFile` | history actions | **Yes** — every navigator write touches it |
| Agent state snapshot | reads `workspaceView`/`currentFile`/`view`/`breadcrumbs`/`runningScript` | writes `.codeswim/agent-state.json` (debounced) | **Yes** — renderer→disk→agent `get_app_state` tool ([app-view.ts](packages/harness/src/tool/app-view.ts)) |

---

## Open questions / anomalies (seeds for user stories)

1. **Two AI surfaces, no shared state.** "Agent" (opencode chat) and "Claude Code" (embedded CLI) are separate sections with separate histories. Which is the canonical way to talk to AI? What happens if a user works in both? Neither knows about the other's session.
2. **Two terminals.** `terminal` and `claude` are the same component in two rail slots; a user wanting "a terminal" sees two terminal-ish icons.
3. **Agent chat is both a panel and a bus.** Six features inject prompts into it and two run invisible ephemeral sessions ([state.tsx:1196](apps/desktop/src/renderer/src/state.tsx#L1196)/[1219](apps/desktop/src/renderer/src/state.tsx#L1219)). Opening the agent panel can show a conversation the user didn't start (e.g. after Sync or PR review). Is the visible chat the source of truth?
4. **Tools section hijacks the main window.** Selecting `tools` replaces the navigator/board with `SkillsView`/`McpView` ([App.tsx:220](apps/desktop/src/renderer/src/App.tsx#L220)), and switching workspace view force-clears `activeSection: 'tools'` ([state.tsx:391](apps/desktop/src/renderer/src/state.tsx#L391)). Unlike every other section (which only fills the left rail), Tools is a rail selection that commandeers the main surface — an inconsistent mental model.
5. **MCP is stubbed twice with different copy.** Rail tab ([SkillsPanel.tsx:406](apps/desktop/src/renderer/src/components/SkillsPanel.tsx#L406)) and main view ([McpView.tsx](apps/desktop/src/renderer/src/components/McpView.tsx)) both say "coming soon" independently.
6. **Diff viewer has no home.** It's a transient main-window state written by both git and PR panels; there's no persistent "changes" surface — closing it guesses `prevView`.
7. **Explore tab is disabled without a current file** ([App.tsx:133](apps/desktop/src/renderer/src/App.tsx#L133)) but Plan is always enabled — a workspace with no markdown can only reach the board, not the navigator.
8. **Coverage/Sync has no visible surface** — its results always borrow chat, a toast, or the Commit panel's state machine. There's nowhere to just *see* diagram/source drift.
9. **Badge/panel decoupling.** git and PR counts are fetched centrally even when panels never mount ([state.tsx:981](apps/desktop/src/renderer/src/state.tsx#L981)) — good for glanceability, but means the badge and the panel can momentarily disagree.
10. **Kanban GitHub Projects sync** is half-present (contract + draft UI) — unclear whether it's usable end-to-end or aspirational.
11. **Search is filename-only.** Users expecting content/grep search (this is a code navigator) will find only path matches.
12. **Team chat silently unavailable** when there's no shared git remote ([RoomChatPanel.tsx:33](apps/desktop/src/renderer/src/components/RoomChatPanel.tsx#L33)) — the section still appears in the rail.
</content>
</invoke>
