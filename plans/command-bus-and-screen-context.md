# Command bus + scoped screen context for codeswim

## Context

[research/ai-aware-desktop.md](../research/ai-aware-desktop.md) argues an AI-native desktop app needs
**state, semantics, and actions** cleanly separated, and closes by asking whether codeswim has that
today. It doesn't.

What exploration found:

- **Actions don't exist as a concept.** Behavior is ~50 imperative methods on `StoreApi`
  ([store.ts:212-309](../apps/desktop/src/renderer/src/store.ts#L212-L309)), plus **direct `window.api`
  IPC from 9 components** that the store knows nothing about. There is no registry, no palette,
  and exactly one global keybinding (`App.tsx:340`).
- **State and side effects are fused.** [state.tsx](../apps/desktop/src/renderer/src/state.tsx) is 2064
  lines: a 340-line pure reducer and ~1500 lines of effectful service code inside one component.
- **Multi-step business workflows live in JSX.** `KanbanView.tsx:479-548` runs a git bootstrap
  (`gitInit` → `gitStageAll` → `gitCommit`) behind a `window.confirm`, then a worktree +
  dependency-ordered agent scheduler. `GitPanel.tsx:198-275` holds the entire commit/sync policy.
  `SkillsView.tsx:47-145` does raw file CRUD over IPC.
- **The agent is a second-class user.** `DiagramNavApi` has 79 members; `StoreApi` has ~50; the agent
  has **7 tools** ([plugin.ts:129-305](../packages/harness/src/plugin.ts#L129-L305)), and its only way to
  drive the UI is fire-and-forget `codeswim_action` metadata with two variants
  ([api.ts:236](../packages/contract/src/api.ts#L236)) that returns no result.

The essay's framework argument (Electron for CDP/`getFullAXTree`) is **not** what we're acting on —
it concedes itself that the shell is replaceable, and CDP is a tool for automating apps you don't own.
The load-bearing insight is the command layer. That's the work.

Two decisions taken with the user:

1. **Progressive disclosure is a hard requirement.** The agent must not carry ~130 tools of context.
   Verified constraint: opencode's plugin returns its `tool` map **once at init**
   (`@opencode-ai/plugin` exposes only `tool.definition` for rewriting descriptions), so disclosure
   must be _meta-tool shaped_ — a small fixed tool list with search behind it, not dynamic
   registration.
2. **No parallel `<AgentElement>` tree.** codeswim's content already lives on disk and the agent has
   `read`/`grep`. The scarce information is deixis, selection/focus, and state that never hits disk
   (terminal output, loaded diff, coverage results). That's ~4 typed blocks, not ~40 elements.

**Outcome:** one command registry that the UI, keyboard, and agent all call; the agent reaching the
long tail through search instead of a bloated tool list; and a scoped screen-context object so it
knows what the user is looking at. Incremental and always-green — no `packages/core` big bang.

---

## Design

```
  UI components ─┐
  keybindings  ─┼─→ commands.run(id, args, origin) ─→ policy ─→ handler ─→ dispatch / window.api
  agent bridge ─┘         (registry)                 (scope + danger)
```

Three new pieces, introduced incrementally before the legacy paths are removed:

**1. Command registry** — `apps/desktop/src/renderer/src/commands/`

```ts
export interface Command<A = unknown, R = unknown> {
  id: string // 'git.commitGroup', 'nav.openFile'
  domain: string // derived from id prefix
  title: string // human label (future palette)
  description: string // one line, agent-facing
  schema: JSONSchema // structural args, used by describe + validation
  validate?(args: A, ctx: CommandCtx): void // semantic validation (paths, current selection)
  agent: 'hot' | 'listed' | 'never' // disclosure tier
  danger?: {
    kind: 'destructive' | 'network'
    summarize(args: A, ctx: CommandCtx): string
  } // enforced by registry before run
  run(args: A, ctx: CommandCtx): Promise<R>
}
```

`CommandCtx` gives handlers `{ getState, dispatch, api: window.api, toast, activeRoot, executionRoot,
origin, confirm }`. `getState()` and the root getters read refs at invocation time; a registry created
on the first render must never capture an `AppState` or root-path snapshot. `origin` is either
`{ kind: 'human' }` or `{ kind: 'agent', sessionId, worktree }`. For human calls, `executionRoot` is
the active workspace. For agent calls, it is the caller's validated worktree. View-only commands may
target the active renderer, but any filesystem command must use `executionRoot`.

JSON Schema handles structure, not authority. File-bearing commands also use a shared semantic path
validator: paths must be relative POSIX paths, contain no `..`, and resolve inside `executionRoot`.
The main-process IPC method remains the final containment boundary; agent-reachable navigation must
use a root + relative-path IPC operation rather than the unrestricted absolute `readFile` call.

`StoreApi` stays as-is and its methods become thin `commands.run(...)` wrappers, so **no component
changes are required to land the registry**. Synchronous-looking wrappers such as `setWorkspaceView`
explicitly handle rejected command promises instead of creating unhandled rejections.

**2. Command bridge** — how the out-of-process agent invokes commands _and gets a result back_.

Reuse the exact pattern already proven by chat: env-injected config + an I/O-injected pure module.

- Main starts a `node:http` server on `127.0.0.1:0`. Each sidecar start issues a capability containing
  a random token bound to that workspace root; stopping the harness or switching roots revokes it.
  Main threads
  `CODESWIM_COMMAND_URL` + `CODESWIM_COMMAND_TOKEN` through
  [sidecar-env.ts](../apps/desktop/src/main/sidecar-env.ts) alongside the existing `CODESWIM_CHAT_*` vars.
- Main proxies each request to the renderer over IPC with a correlation id; the renderer runs the
  command and replies. The preload surface exposes typed request subscription + reply methods. One
  registry, living where `StoreApi` already is.
- Harness side mirrors [tool/chat.ts](../packages/harness/src/tool/chat.ts): a pure
  `tool/command.ts` with `resolveCommandConfig(env)`, `findCommand`, `runCommand`, and an injected
  `CommandIo`. Each request carries `ctx.sessionID` and `ctx.worktree`; main accepts only the bound
  workspace or a worktree registered for it. Worktree create/remove updates that registry, and
  startup validation reconciles it against `git worktree list --porcelain` so restored tabs work.

The protocol is versioned JSON over `POST`, accepts only the two known routes, caps request bodies at
64 KiB, and has a 15-second end-to-end timeout. Missing/not-ready renderers return `503`; invalid
tokens return `401`; validation/policy failures are typed 4xx `CommandError`s; handler failures are
typed 5xx errors. Pending correlation entries are removed on response, timeout, renderer destruction,
server close, and client disconnect.

This **replaces** the `codeswim_action` metadata channel — `open_file`/`set_view` become ordinary
commands with real return values, and `applyViewAction` ([state.tsx:1688](../apps/desktop/src/renderer/src/state.tsx#L1688)) goes away.

**3. Surface context** — `apps/desktop/src/renderer/src/context/`

```ts
// packages/contract/src/api.ts — supersedes AppStateSnapshot
export interface ScreenContextV2 {
  version: 2
  workspaceView: 'navigator' | 'kanban' | 'agents'
  focus: {
    surface: 'navigator' | 'kanban' | 'agents' | 'diff' | 'terminal' | 'script-output'
    itemId: string | null
  }
  surfaces: {
    navigator?: NavigatorSurfaceContext
    kanban?: KanbanSurfaceContext
    diff?: DiffSurfaceContext
    terminal?: TerminalSurfaceContext
    scriptOutput?: ScriptOutputSurfaceContext
  }
}
```

A `useSurfaceContext(name, block)` hook lets each mounted surface contribute its own typed block —
which is how component-local `useState` becomes visible without hoisting everything into the reducer.
The provider owns an external-store-style block registry with `upsert`, `remove`, `getSnapshot`, and
`subscribe`. It compares snapshots before incrementing a revision, removes blocks on unmount/root
change, and derives `focus` from the active workspace/transient view rather than whichever component
rendered last.

The existing publisher is replaced: one debounced subscriber composes reducer state plus the surface
registry and publishes whenever either changes. Terminal/script output is ANSI-stripped, bounded by
lines and bytes, and only included for the active tab/surface. Publishing remains best-effort and
atomic at `.codeswim/agent-state.json`.

**Agent tool list after this work (8 when workspace chat is configured, 6 otherwise, down from an
alternative ~130):**

| tool                                                   | tier                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| `diagram_edit`, `kanban_add`, `chat_read`, `chat_send` | existing, unchanged                                                      |
| `get_app_state`                                        | existing, now returns `ScreenContextV2`                                  |
| `find_command(query)`                                  | new — ranked search over `agent: 'listed'` commands, returns id + schema |
| `run_command(id, args)`                                | new — description embeds _domain names only_, never the command list     |
| `open_file`                                            | promoted to a hot command, real result                                   |

---

## Work, in landing order

### Phase 1 — Registry, no behavior change

- `packages/contract/src/commands.ts`: versioned `CommandDescriptor`, `CommandRequest`,
  `CommandResult`, `CommandError`, `CommandOrigin`, and the structural JSON schemas.
- `commands/registry.ts` (`register`, `run`, `find`, `describe`) + `commands/context.ts` (`CommandCtx`).
- Instantiate the registry in `StoreProvider`; expose `commands` on `StoreApi`. Build `CommandCtx`
  per invocation from refs (`getState()` / current roots), not from render-time state.
- The registry validates schema + command semantics before policy and handler execution. Duplicate
  ids, unknown ids, invalid args, and forbidden origins return stable typed errors.
- Migrate the **navigation slice first** — `navigateRelative`, `navigateAbsolute`, `inspectFile`,
  `openSourceCode`, `popTo`, `goBack`, `goForward`, `setWorkspaceView` — into `commands/nav.ts`.
  Existing `StoreApi` methods delegate. Preserve the current `open_file` path guard and make the
  main-process file read root-scoped before exposing navigation to generic `run_command`. Nothing
  else moves.
- Unit tests against the registry directly (it's framework-free); reuse the `browser-stub.ts`
  fake `window.api` as the `ctx.api` test double. Include stale-state, traversal, origin, duplicate-id,
  and concurrent-command cases.

### Phase 2 — Bridge + agent tools

- `main/command-server.ts` (loopback HTTP, scoped capability, correlation-id IPC proxy). Bind to
  `127.0.0.1` explicitly and implement the protocol limits/lifecycle above. Token comparison is
  timing-safe; capabilities rotate on harness restart/root change.
- Add the typed main ↔ preload ↔ renderer request/reply seam to `DiagramNavApi` and its tests.
- `sidecar-env.ts`: add the two vars; extend `SidecarEnvResult` tests.
- `harness/src/tool/command.ts` + wire `find_command` / `run_command` in
  [plugin.ts](../packages/harness/src/plugin.ts). Register them **only when
  `resolveCommandConfig(env)` is non-null**, exactly as the chat tools do. Forward `ctx.sessionID`
  and `ctx.worktree` on every request.
- Reroute `open_file` / `set_view` through the bridge; delete `AgentViewAction`, `applyViewAction`,
  and the metadata branch at `state.tsx:622-626`.
- Agent policy is fail-closed from the first bridge commit: `danger` commands and `agent: 'never'`
  commands are rejected for agent origins even if invoked directly by id. Only side-effect-free or
  explicitly safe commands ship as `hot`/`listed` in this phase.
- Update [architecture/agent-harness.md](../architecture/agent-harness.md) — its diagram is the spec.

### Phase 3 — Screen context

- Add the typed, versioned `ScreenContextV2` blocks to the contract. Keep `AppStateSnapshot` for one
  release and make `formatAppState` parse a runtime union by version/shape; a TypeScript alias alone
  does not make stale JSON compatible.
- `context/surface-context.ts` (registry + subscription), `context/useSurfaceContext.ts`, and a
  provider in `StoreProvider`. Replace the reducer-only publish effect with the composed subscriber.
- Contribute blocks from four surfaces: `DiagramView` (clicked node, mermaid errors), `KanbanView`
  (columns, open card, running cards), `DiffView` (`diffPath`, hunk count), `TerminalPanel` /
  `ScriptOutput` (bounded, active-only tail of output).
- Update `formatAppState` in [tool/app-view.ts](../packages/harness/src/tool/app-view.ts) to render the
  new shape.

### Phase 4 — Approval seam (fail closed; UX remains follow-up)

`sidecar.ts:103-107` currently sets `permission: 'allow'` with a comment anticipating exactly this.
Implement the `ctx.confirm(danger, summary)` used by the registry. Human-origin calls use an injected
confirmation adapter, initially preserving the existing `window.confirm` behavior; both acceptance
and cancellation are real command results. Agent-origin calls resolve `false` unless a future
approval service returns a scoped grant. The registry derives the summary from the command's
`danger.summarize` and enforces the decision before the handler, independent of opencode's current
`permission: 'allow'`. Unit-test that a forged direct `run_command` call cannot bypass either
`agent: 'never'` or `danger`.

**Ship the fail-closed seam; leave approval UX for a follow-up.** That follow-up must define grant
scope (single call / command / workspace), expiry, cancellation, and how background agent tabs surface
requests. Until it lands, dangerous commands remain human-only rather than silently auto-approved.

**Done.** Most of this mechanism already existed from Phase 1 — `CommandCtx.confirm` and the
registry's schema → validate → confirm → run ordering were built then, anticipating this phase. What
Phase 4 actually added:
- Named the injection point explicitly: `humanConfirmAdapter` (state.tsx) wraps `window.confirm`
  behind a one-function seam, so a future modal-based approval UI is a swap there, not a registry
  change.
- Reworded the `sidecar.ts` `permission: 'allow'` comment to state plainly that it's orthogonal to
  the registry's own gate — `find_command`/`run_command` being opencode tools opencode auto-approves
  says nothing about whether a `danger` command reached through them gets approved.
- Test coverage the mechanism never had: human confirm/cancel (cancel is a typed `denied` result, not
  a thrown error, and the handler never runs), agent-origin auto-deny even for `agent: 'listed'`
  commands, a forged-origin bypass attempt on `danger` (mirrors the existing `agent: 'never'` bypass
  test from Phase 1), and confirming the summary is derived strictly after validation.
- No real command has `danger: true` yet — that arrives in Phase 5 (`kanban.runCard`, `git.sync`,
  etc.), where this seam gets its first live exercise.

### Phase 5 — Drain the fat components

Move workflows out of JSX one surface at a time:

- `KanbanView.tsx` → `commands/kanban.ts` (`kanban.load`, `kanban.save`, `kanban.githubSync`,
  `kanban.moveCard`, `kanban.ensureRepo`, `kanban.runCard`, `kanban.runColumn`) plus a board-file watch
  hook. Reuse the already-extracted `kanban-run-all.ts` helpers. The run commands spawn agents and
  mutate git, so they use `danger.kind: 'destructive'`, `agent: 'never'` in this pass.
- `GitPanel.tsx` → `commands/git.ts` (`git.refreshStatus`, `git.loadHistory`, `git.init`, `git.sync`,
  `git.commitPlan`). Reuse `runCoverage` / `buildSyncPrompt` from
  [coverage/run.ts](../apps/desktop/src/renderer/src/coverage/run.ts). Sync and commitPlan are
  `agent: 'never'`: sync invokes another agent during triage and both can mutate git/network.
- `SkillsPanel.tsx` + `SkillsView.tsx:47-145` → `commands/skills.ts`; destructive writes/deletes are
  `agent: 'never'`.
- `RoomChatPanel.tsx:95-175` + `PullRequestsPanel.tsx` → `commands/github.ts`; auth/status event
  subscriptions move to a hook. Sign-in, sign-out, merge, and other network mutations are
  `agent: 'never'`.
- `ReadView.tsx` user-triggered file loads → navigation commands using scoped file IPC.
- `UpdateButton.tsx` install action → `commands/app.ts`; update-status subscription moves to a
  dedicated hook.
- `TerminalPanel.tsx` lifecycle and data subscriptions move to a dedicated terminal adapter/hook;
  creating, writing to, and destroying terminals are not exposed to agents in this pass.

Target: no user-triggered `window.api.` workflow calls left directly in `components/`. IPC event
streams live in named adapters/hooks rather than being misrepresented as commands. Every command has
an explicit agent tier; safe commands provide parity now, while dangerous and agent-spawning commands
stay human-only until approval UX exists. Agent-exposed handlers must never call `ensureAgent`,
`sendChat`, or `startAgentInWorktree`, preventing tool → agent → tool recursion.

**KanbanView.tsx — done.** `commands/kanban.ts` registers `kanban.load` (agent: `listed`, read-only)
and `kanban.save` / `kanban.githubSync` / `kanban.moveCard` / `kanban.ensureRepo` / `kanban.runCard` /
`kanban.runColumn` (all `agent: 'never'` — deliberately more conservative than the plan's literal
text, which only called out the run commands; card mutation stays human-only too, matching the
GitHub-collaborator card-creation concern captured in `plans/multiplayer-kanban-board.md` Decision 5).
`runCard`/`runColumn` are `danger: 'destructive'` and are the seam's first live exercise — verified
live that a declined `window.confirm` blocks the worktree/agent spawn entirely. `CommandCtx` gained a
`startAgentInWorktree` field (agent-spawning capability, only ever called from `agent: 'never'`
handlers) since `kanban.runCard` needs it. A new `KanbanRunTracker` (module-scoped per registry
instance, exposed on `StoreApi.kanbanRunningCardIds` via `useSyncExternalStore`) replaced the
component's local running-card `Set` so cards auto-launched by "Run all" as dependencies clear still
show as running in the UI, not just ones the component itself triggered. `KanbanView.tsx` no longer
calls `window.api.kanban*`/`window.api.git*` directly; the board-file watch subscription
(`window.api.onFileChanged`) stays in the component per the plan's adapter/hook carve-out. 18 new
unit tests in `commands/kanban.test.ts`; live-verified (create/edit/delete a card, and the danger gate
firing on "Start in background") against `examples/sample-architecture`.

**GitPanel.tsx — done.** `commands/git.ts` registers `git.refreshStatus`/`git.loadHistory` (agent:
`listed`, read-only) and `git.init`/`git.sync`/`git.commitPlan` (`agent: 'never'`). Also added
`kanban.listWorktrees` to `commands/kanban.ts` (the Sync panel's card-target switcher reads worktree
info, which is kanban-domain data, not git-domain) — not in the plan's literal list but needed to fully
clear "no `window.api.` calls left in this component." Deliberately **no `danger` gate** on `git.init`/
`git.commitPlan`: both already have their own human-in-the-loop step in the existing UI (an explicit
"Start tracking" click; the PlanReview screen's reviewed "Save" click) — an extra `ctx.confirm` on top
would be double-asking, not an additional safeguard. `CommandCtx` gained `planSync`/`commitGroup`
fields (same agent:'never'-only rule as `startAgentInWorktree`) since `git.sync`/`git.commitPlan` need
to reach the pre-existing ephemeral-session agent-triage callbacks that already lived in `state.tsx`.
The Sync flow's fine-grained progress labels ("Looking at your changes…" → "Asking the agent to sort
it out…") collapsed to a single "Working…" state during `git.sync` — the multi-step label couldn't
survive the move since the intermediate steps now happen inside one command call the component can't
peek into mid-flight; everything else (coverage gate, obvious-commit auto-save, plan review, ignore
patterns, card-worktree target switching) is unchanged. 13 new unit tests in `commands/git.test.ts`;
live-verified (non-repo folder → "Start tracking", and an existing repo's changes list + commit
history) against isolated throwaway repos.

**SkillsPanel.tsx/SkillsView.tsx — done.** `commands/skills.ts` registers 11 commands: `skills.list`/
`listFiles`/`readFile`/`readAgentsDoc` (agent: `listed`, read-only) and `writeFile`/`writeAgentsDoc`/
`create`/`delete`/`linkFolder`/`openInEditor`/`openAgentsDocInEditor` (`agent: 'never'`). Read/write
split mirrors the two underlying storage paths (skill files vs. AGENTS.md) faithfully rather than
forcing an artificial unification. `writeFile`/`writeAgentsDoc` are never agent-reachable for a
sharper reason than usual: a skill or AGENTS.md **is** the agent's own system prompt, so an
agent-reachable write is a direct self-modification path, not just an ordinary mutation. `skills.delete`
picked up a real `danger: 'destructive'` gate (replacing its ad hoc `window.confirm`) — same
"unlink vs delete" summary wording as before, second surface (after `kanban.runCard`) to actually
exercise Phase 4's seam. The native folder-picker dialog (`pickSkillLinkSource`) stays a direct
`window.api` call in the component, matching `pickRoot`'s existing precedent — OS dialogs aren't
schema-args-driven and can't sensibly be commands. 17 new unit tests in `commands/skills.test.ts`;
live-verified end-to-end (create a workspace skill → edit → save → delete with the danger gate firing
and the file actually gone from disk) against a throwaway temp folder, workspace-scope only so nothing
touched the real `~/.agents/skills`.

Remaining for this phase: `RoomChatPanel.tsx`/`PullRequestsPanel.tsx`, `ReadView.tsx`,
`UpdateButton.tsx`, `TerminalPanel.tsx`.

---

## Explicitly not doing

- **Not** switching to Tauri, and not adopting CDP / `Accessibility.getFullAXTree`. A mermaid SVG's
  AX tree is a pile of unlabeled paths; we own the app, so we describe it directly.
- **Not** building `packages/core`. The registry lives in `apps/desktop` until a second consumer
  justifies extracting it.
- **Not** an MCP server yet. The registry is the right internal boundary; MCP adapts onto it later
  (and would fix the two `McpView` stubs), but it isn't load-bearing now.
- **Not** reshaping the reducer or broadly redesigning the 79-method `DiagramNavApi`. The only API
  additions are the typed command request/reply bridge and root-scoped file access required to keep
  agent-reachable navigation contained.

---

## Verification

- `npm run typecheck && npm run lint && npm run test` at the repo root after each phase.
- **Phase 1** — registry unit tests; then `npm run dev` and confirm navigation, breadcrumbs, back/
  forward, and mermaid `click ... call navigate(...)` still work. Mermaid needs `securityLevel:
'loose'` and the CSP's `'unsafe-eval'`; there are two prior regressions of that exact shape, so
  render a diagram before calling the phase done. Unit-test that commands observe state changes made
  after registry creation and reject absolute/traversal paths.
- **Known issue blocking live E2E of Phase 2 (and every other harness tool) in this dev environment:**
  opencode (`opencode-ai` 1.14.46) fails to load `out/harness/plugin.mjs` with `must export id failed
  to load plugin` — confirmed in `~/Library/Application Support/@codeswim/desktop/opencode-xdg/data/
  opencode/log/*.log` going back to at least 2026-08-15, so it predates this work and isn't caused by
  it. It means `diagram_edit`/`kanban_add`/`chat_read`/`chat_send`/`get_app_state` and the new
  `open_file`/`find_command`/`run_command` are all unregistered at runtime here, even though they
  build correctly and the bundle contains them. Likely an opencode plugin API version mismatch
  (`export const id` expected alongside/instead of `export default`). Worth a `/run-skill-generator`
  pass or a dedicated fix before trusting *any* live agent-tool demo in this environment — unit tests
  against the pure command/plugin modules (which don't depend on opencode actually loading the
  bundle) are the only Phase 2 verification that ran end-to-end here.
- **Phase 2** — with `npm run dev` running, `curl` the loopback command server with and without the
  token (expect `401` without), with an oversized/malformed body, with the renderer unavailable, and
  across a workspace switch (the old token must stop working). Force a renderer timeout/disconnect
  and assert the pending-correlation map returns to zero. From an isolated Kanban worktree, confirm a
  filesystem command uses that worktree or is rejected—never the main checkout. Then in the agent
  panel: "open architecture/renderer.md" (hot path) and "what npm scripts can you run?" (must go
  through `find_command`, not a preloaded list). Confirm the tool list is 8 entries when chat is
  configured and 6 otherwise. Direct invocation of a `danger` or `agent: 'never'` id must fail.
- **Phase 3** — open a Kanban card, ask the agent "what am I looking at?", and check
  `.codeswim/agent-state.json` contains the kanban block with the open card id. Change only local
  component state and verify the file republishes; unmount/switch roots and verify stale blocks are
  removed. Feed `formatAppState` legacy, v2, malformed, and partial JSON. Confirm terminal output is
  active-only, ANSI-stripped, and bounded.
  **Done, minus the "ask the agent" half** — same pre-existing plugin-load failure noted under Phase
  2 blocks it. Verified the other half directly: built the app, drove it with Playwright (demo →
  Kanban tab → create a card → reopen it) and read `.codeswim/agent-state.json` at each step —
  `focus`/`surfaces.kanban` tracked correctly, `openCardId` populated on reopen. Registry
  upsert/remove/clear semantics, `composeScreenContext`'s focus precedence, and `formatAppState`'s
  four-shape parsing are covered by unit tests instead of live-agent checks. `runningScript` ended up
  as its own always-present field (not gated on focus) since the old "Running script: X" line needs
  to survive even when script-output isn't the focused surface — the bounded/ANSI-stripped/
  active-only rule from this doc applies to the *tail*, not the fact that something's running.
- **Phase 4** — test both entry paths: human-origin dangerous commands run only after confirmation
  and do nothing when confirmation is cancelled; agent-origin dangerous commands return a typed
  denial before executing any handler or IPC. A forged id/args payload and opencode's global
  `permission: 'allow'` must not bypass registry policy. Assert the danger summary is derived only
  after validation, so invalid/untrusted args cannot generate misleading prompts.
- **Phase 5** — per component: run the real workflow by hand (Kanban Run-all in a scratch repo,
  GitPanel Sync with uncommitted changes). Exercise safe commands through the agent and confirm
  identical results; confirm dangerous and agent-spawning commands remain denied. Finally,
  `rg 'window\.api\.' apps/desktop/src/renderer/src/components` should find no user-triggered
  workflow calls; any remaining subscription must live in a named adapter/hook with a documented
  exception.
- Point the app at `codeswim-example` for the end-to-end pass, and unset `ELECTRON_RUN_AS_NODE`
  first if the shell has it set.
