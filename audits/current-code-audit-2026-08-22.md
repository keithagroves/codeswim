# Current code audit — 2026-08-22

## Executive summary

The command-bus and screen-context work is pointed in the right architectural direction: the renderer now has a central registry, agent policy is enforced at that registry, the loopback bridge has a narrow authenticated surface, and Kanban/Git workflows have started moving out of React components.

The current working tree is not ready to ship the agent command bridge, however. Three issues should be treated as release blockers:

1. Agent-visible read commands accept caller-controlled absolute roots even after the server validates a different worktree.
2. Harness start/stop is vulnerable to workspace-switch races and can associate a sidecar with the wrong root.
3. The progressive-disclosure tools omit the command schema and real command result from their model-visible output; the system prompt also directs the agent to use a removed tool.

The repository typechecks and the unit suites pass when loopback sockets are allowed. Lint remains substantially red, and the new Electron E2E suite was not run as part of this audit.

## Scope and method

This is a static review of the exact working tree on 2026-08-22, including uncommitted and untracked files. It focuses on the implementation described by [`plans/command-bus-and-screen-context.md`](../plans/command-bus-and-screen-context.md), its security boundaries, lifecycle behavior, screen-context correctness, migration progress, and automated checks. It is not a review of only the last commit.

Severity used below:

- **P1 — blocker:** fix before treating the agent bridge as shippable.
- **P2 — important:** correctness or maintainability issue that should be resolved in the current implementation cycle.
- **P3 — follow-up:** meaningful divergence or hardening work that can follow the blockers.

## Validation snapshot

| Check | Result | Notes |
| --- | --- | --- |
| `npm run typecheck` | Pass | 9/9 workspaces passed. |
| `npm run lint` | Fail | 78 errors and 392 warnings. The largest error groups are `react-hooks/refs` (31), explicit return types (29), and CommonJS `require` usage (8). |
| `npm run test` | Conditional pass | 224 tests passed in the restricted sandbox. The remaining 17 command-server tests were blocked only by `listen EPERM 127.0.0.1`; that isolated suite passed 17/17 with loopback permission. Across both runs, all 241 distinct unit tests passed. |
| Electron E2E | Not run | The Playwright/Electron files are present but untracked. No GUI smoke result is claimed here. |

## Findings

### AUD-01 — P1 — Validated worktree can be bypassed through command arguments

The loopback server correctly requires a live Git worktree and places that validated value in `origin.worktree` ([`command-server.ts`](../apps/desktop/src/main/command-server.ts), lines 220–260). Some agent-listed handlers then ignore that boundary:

- `git.refreshStatus` and `git.loadHistory` require an arbitrary `dir` and pass it directly to privileged IPC ([`commands/git.ts`](../apps/desktop/src/renderer/src/commands/git.ts), lines 161–183).
- `kanban.load` and `kanban.listWorktrees` require an arbitrary `root` ([`commands/kanban.ts`](../apps/desktop/src/renderer/src/commands/kanban.ts), lines 341–358).

A token-holding agent can therefore submit a registered worktree in the envelope while asking these handlers to read another filesystem path accessible to the app. This contradicts the contract comment that agent filesystem work must use the origin root.

**Recommendation:** for every agent-visible filesystem command, derive the effective root from `ctx.executionRoot`; do not trust a root-like argument. If the same command must support human-selected roots, either split the command or require equality for agent origins. Add negative tests where the envelope worktree and command argument differ.

### AUD-02 — P1 — Sidecar lifecycle is not serialized by workspace

`harness:start` shares one global `sidecarStarting` promise. If start A is in flight and start B arrives, B awaits A's promise and then records `sidecarRoot = B`, even though the process and issued capability were created for A ([`main/index.ts`](../apps/desktop/src/main/index.ts), lines 760–806).

The stop path revokes the capability and returns immediately when `sidecar` is still null, without cancelling or awaiting an in-flight start (lines 809–815). The renderer makes this reachable during normal navigation by firing `stopHarness()` without awaiting it and then eagerly starting the new workspace agent ([`state.tsx`](../apps/desktop/src/renderer/src/state.tsx), lines 1519–1543).

**Impact:** rapid workspace switches can mislabel the active sidecar root, return the wrong URL, or leave a newly started process with a revoked command capability.

**Recommendation:** replace the loose globals with a serialized lifecycle state machine keyed by requested root. Await/cancel the previous generation before publishing the next one, and ignore late completions using a generation token. Cover start(A) → start(B), stop-during-start, and process-exit-during-switch.

### AUD-03 — P1 — Agent command discovery and execution hide required information

The tool descriptions promise argument shapes and real results, but the model-visible text does not provide them:

- `formatCommandList` renders only id and description, dropping `schema`, `title`, and policy metadata ([`tool/command.ts`](../packages/harness/src/tool/command.ts), lines 97–99).
- `run_command` renders only `Ran <id>.`; the result is placed in metadata rather than the textual output ([`plugin.ts`](../packages/harness/src/plugin.ts), lines 319–339).
- The system prompt still tells the agent to call the deleted `set_view` tool and refers to “these three tools” ([`prompt/system.txt`](../packages/harness/src/prompt/system.txt), lines 21–28).

This breaks the intended progressive-disclosure loop: the agent cannot reliably construct long-tail calls from discovery output, and read commands do not return useful observations in the channel the model reads.

**Recommendation:** render a compact JSON-schema summary in `find_command`, include a bounded/serialized command value in `run_command` output, and update the prompt to use `run_command('nav.setWorkspaceView', ...)` or discovery. Test the final tool text, not only the transport result.

### AUD-04 — P2 — Versioned app-state parsing is compile-time-only

`formatAppState` treats any object with `version === 2` as a complete `ScreenContextV2` and immediately formats it ([`tool/app-view.ts`](../packages/harness/src/tool/app-view.ts), lines 124–143). A syntactically valid partial snapshot such as `{"version":2}` can therefore throw instead of degrading gracefully.

The bridge has the same general issue: the contract calls itself versioned, but `CommandRendererRequest` and its HTTP envelope carry no protocol version ([`contract/commands.ts`](../packages/contract/src/commands.ts), lines 80–99).

**Recommendation:** validate the V2 shape at runtime (or make the formatter field-safe), add partial/malformed V2 cases, and put an explicit protocol version on the bridge envelope before compatibility matters.

### AUD-05 — P2 — Published screen state is not available to isolated agent worktrees

The renderer publishes `.codeswim/agent-state.json` under the active UI workspace root ([`state.tsx`](../apps/desktop/src/renderer/src/state.tsx), lines 1843–1857). `get_app_state` reads that path under `ctx.worktree` instead ([`plugin.ts`](../packages/harness/src/plugin.ts), lines 344–355).

For an agent running in an isolated Kanban worktree, that ignored runtime file generally does not exist there. The tool reports that no state has been published even though the app has current state.

**Recommendation:** pass the active snapshot path through the sidecar environment, or expose screen context through the authenticated app bridge. Keep the agent execution root and the UI-context source as two explicitly named concepts.

### AUD-06 — P2 — Agent navigation mixes worktree content with active-workspace state

Agent navigation reads the target through `ctx.executionRoot`, then dispatches only a relative file path into shared renderer state. The store's `rootPath` remains the human's active checkout. Follow-on UI actions such as “Open in editor” can therefore apply the relative path to the main checkout instead of the worktree whose content was displayed.

**Recommendation:** make the ownership rule explicit. Either agent-driven UI navigation is restricted to the active workspace, or document state must carry its source root and every later action must honor it. Add a two-worktree integration test with divergent contents at the same relative path.

### AUD-07 — P2 — Quality gates are not yet a reliable merge gate

Typechecking and unit behavior are healthy, but lint currently fails with 78 errors. The errors include renderer ref access during render, state updates in effects, E2E fixture hook false positives, and script/config style violations. The E2E suite is also separate from `npm test` and currently untracked.

The ref warnings deserve triage rather than blanket suppression: `App.tsx` and `state.tsx` use refs to maintain state outside the render model, so they should be distinguished between intentional external-store mechanics and actual render-time mutation.

**Recommendation:** establish a clean baseline by fixing production-code errors, adding narrowly scoped ESLint overrides for Playwright fixtures/scripts where appropriate, and adding a documented CI job for the Electron smoke suite. Preserve the command-server test distinction: loopback permission is an environment requirement, not an application test failure.

### AUD-08 — P2 — Phase 5 migration is incomplete

Kanban command extraction is substantial and Git extraction is now present, but eight renderer components still call `window.api` directly:

- `KanbanView.tsx` (event subscription carve-out)
- `PullRequestsPanel.tsx`
- `ReadView.tsx`
- `RoomChatPanel.tsx`
- `SkillsPanel.tsx`
- `SkillsView.tsx`
- `TerminalPanel.tsx`
- `UpdateButton.tsx`

This is expected for work in progress, but it means the registry is not yet the single user-action boundary described by the plan. The large central files (`state.tsx` and main `index.ts`) also continue to own several unrelated lifecycle concerns.

**Recommendation:** finish the migration by domain, keeping event streams in named hooks/adapters and actions in commands. Do not count subscription-only `window.api` calls as command violations, but make that distinction visible in code structure.

### AUD-09 — P3 — Screen context does not yet cover the full promised surface

The versioned context, registry, Mermaid errors, Kanban state, diffs, and bounded script output are useful progress. The terminal surface currently exposes tab metadata rather than a bounded active-terminal output tail, despite terminal output being one of the scarce-context targets in the plan.

There is also a lifecycle edge: clearing surface blocks on root change does not itself force mounted `useSurfaceContext` producers with otherwise unchanged dependencies to re-register.

**Recommendation:** add a bounded ANSI-stripped active-terminal tail and make root identity part of surface registration so blocks republish after workspace changes.

### AUD-10 — P3 — Runtime state artifact is not ignored recursively

The working tree contains an untracked generated file at `examples/sample-architecture/.codeswim/agent-state.json`. The root ignore entry `.codeswim/agent-state.json` ([`.gitignore`](../.gitignore), lines 17–26) does not match nested sample workspaces.

**Recommendation:** ignore `**/.codeswim/agent-state.json` (and consider the same policy for other local-only agent state) or add a scoped ignore inside the sample fixture.

### AUD-11 — P3 — Bridge cleanup does not track HTTP client disconnects

Pending renderer requests are cleaned up on reply, timeout, and window teardown, but not when the originating HTTP client aborts. A disconnected sidecar call can remain pending until timeout and its renderer work can continue unnecessarily.

**Recommendation:** bind request/response close or abort events to the correlation id and reject/delete the pending entry. Add an abort test alongside timeout and shutdown coverage.

## What is working well

- The command registry creates fresh context per invocation and centralizes schema validation, semantic validation, origin policy, confirmation, and handler execution.
- Agent policy is fail-closed: `agent: 'never'` and dangerous commands cannot be invoked by forging a direct command id.
- The loopback server binds explicitly to `127.0.0.1`, uses a scoped rotating bearer capability, timing-safe comparison, bounded request bodies, timeouts, and live worktree validation.
- Root-scoped file reads use real paths and symlink containment checks before agent-exposed navigation.
- Screen context is versioned, subscription-based, bounded for script output, and covered by focused tests.
- The removal of the old action metadata path reduces duplicate control planes.
- The unit suite is broad and currently passes when its loopback requirement is available.

## Plan progress

| Plan phase | Assessment |
| --- | --- |
| Phase 1 — Registry/navigation | Substantially complete. Registry, fresh context, validation, navigation migration, and tests are present. |
| Phase 2 — Bridge/tools | Implemented but blocked by AUD-01, AUD-02, and AUD-03. Protocol versioning and disconnect cleanup remain. |
| Phase 3 — Screen context | Mostly implemented. Runtime shape hardening, isolated-worktree access, and terminal-tail coverage remain. |
| Phase 4 — Approval seam | Complete for the stated fail-closed scope; live danger commands exist in Kanban/Git paths. |
| Phase 5 — Component drainage | In progress. Kanban is largely extracted and Git is being extracted; Skills, GitHub/chat, read/update, and terminal surfaces remain. |

## Recommended landing order

1. Close the execution-root bypass for every agent-listed filesystem command and add mismatch tests.
2. Serialize sidecar/capability lifecycle across workspace changes.
3. Repair `find_command`/`run_command` output and the stale system prompt.
4. Separate agent execution root from active screen-context/document root, then harden V2 parsing.
5. Restore a green lint baseline and run the Electron E2E smoke suite.
6. Continue Phase 5 by domain, with direct IPC subscriptions isolated in named adapters.
7. Add protocol versioning, client-abort cleanup, terminal output context, and recursive runtime-state ignores.

## Audit limitations

- No packaged build or interactive Electron walkthrough was performed.
- No GitHub/network workflows were exercised.
- This snapshot includes live, uncommitted work and may become stale as those files change.
