# Talking whiteboard: the agent sketches the design out loud, then builds it

## Context

A prototype in a separate repo (`~/projects/anim/canvas`) showed something worth bringing into codeswim:
you talk to an AI, and it answers out loud while drawing the design on a tldraw whiteboard. It sketches
the parts, lays out trade-offs side by side, waits for you to decide, then builds on your choice. A
demo of it is at `~/projects/anim/walkthroughs/game-architect/build/game-architect.mp4`. In codeswim
the same conversation would go one step further: once you agree on the shape, the agent writes the
code behind the scenes and comes back to walk you through what it built.

### What the prototype measured (Unbiased Pareto, Oct 2026)

These numbers drive most of the design below.

- **Pareto doesn't stream.** `/chat/completions`, `/messages` and `/responses` all send the whole reply
  in one burst at the end. Wait time is roughly 2 s plus 18 ms per output token, and hidden reasoning
  makes it swing from 5 to 16 s for the same size of answer.
- **One line in the prompt cut the wait in half.** "This is a live spoken conversation, so speed
  matters more than polish… do not deliberate" took a first part from 11–16 s down to about 6 s, with
  steady token counts.
- **Two requests at once make it feel live.** A tiny *opener* request (one sentence) comes back in
  1.5–2.5 s and is spoken while the main answer is still being generated. The main answer arrives in
  parts of at most three sentences. Each next part is requested as soon as the previous one arrives,
  so it is ready before the current part finishes speaking. Result: first words at about 1.5 s, no gaps.
- **A compact line format is 3× cheaper.** `{"box":"api","at":[1,0],"label":"API"}` on a grid, instead
  of pixel coordinates, cut output tokens to about a third and made the layouts tidier.
- **The model needs guardrails enforced in code, not just in the prompt.** Even when told not to, it:
  - wiped the board on follow-up questions
  - repeated the opener word for word
  - put boxes on top of each other
  - asked for a color tldraw doesn't have (`gray`), which crashed the canvas
  - let the opener decide trade-offs on the user's behalf
  - wrote HTML into labels

  Each of these now has a small fix in the prototype's renderer (listed under Design).
- **Pages keep the board readable.** Giving each topic its own page (gameplay, accounts,
  multiplayer), with tabs showing them, was what made a three-minute conversation stay legible.

### What codeswim already has

- **The coding agent:** an opencode sidecar on loopback HTTP/SSE with Pareto as the default provider
  ([sidecar.ts:102-131](../apps/desktop/src/main/sidecar.ts#L102-L131)). The Unbiased key lives only in
  opencode's auth store and never crosses IPC
  ([index.ts:183-195](../apps/desktop/src/main/index.ts#L183-L195)).
- **The diagram-first gate:** the harness blocks `write`/`edit`/`apply_patch` until a `diagram_edit`
  has happened in the session ([plugin.ts:381-385](../packages/harness/src/plugin.ts#L381-L385)).
  "The diagram updates first" is already enforced.
- **Hidden sessions:** commit synthesis and sync triage already run in throwaway sessions that never
  show up in the chat ([state.tsx:2170-2211](../apps/desktop/src/renderer/src/state.tsx#L2170-L2211)).
  The narrator can use the same pattern.
- **The command bus:** a registry that the UI, keybindings and agent all call, with screen context
  published for the agent ([commands/registry.ts](../apps/desktop/src/renderer/src/commands/registry.ts)).
  The whiteboard can drive navigation through it ("open the real diagram", "show the diff").
- **Diagrams that link to code:** mermaid diagrams use `click … navigate()`, and the coverage checker
  reads those links ([coverage.ts:200](../packages/coverage/src/coverage.ts#L200)).

### What's missing or in the way

- **No canvas, no speech, no direct model calls.** Nothing in the app uses tldraw, a speech API or an
  LLM outside opencode.
- **The CSP blocks two things the feature needs**
  ([index.html:7](../apps/desktop/src/renderer/index.html#L7)):
  - There's no `media-src`, so audio from `blob:` URLs is refused.
  - tldraw loads its fonts, icons and translations from a CDN that `font-src`/`img-src`/`connect-src`
    don't allow.
- **The agent event stream drops what a walkthrough needs.** `agent.ts` forwards only text, reasoning
  and tool parts, and throws away tool input, output and title. It also ignores `session.idle`,
  `session.diff`, `file.edited` and todo events
  ([agent.ts:299-350](../apps/desktop/src/renderer/src/agent.ts#L299-L350),
  [agent.ts:495-514](../apps/desktop/src/renderer/src/agent.ts#L495-L514)). Without them, the narrator
  can't tell when the build finished or what changed.
- **The plugin may not load.** The command-bus plan recorded opencode failing to load
  `out/harness/plugin.mjs` on 1.14.46, which left every harness tool unregistered. The repo is now on
  1.18.21, but whether that's fixed hasn't been checked. The build hand-off depends on `diagram_edit`.
- **The Claude Code tab can't be narrated.** It's a pty, and its only structured signals are `openDiff`
  and `openFile` ([claude-ide.ts](../apps/desktop/src/main/claude-ide.ts)). Only the opencode agent
  reports what it's doing in a form we can read.

### How it fits the philosophy

[philosphy.md](../philosphy.md) seems to argue against this feature in three places. All three are
resolved by being precise about *what* the whiteboard narrates.

1. **"Hide the agent's inner loop. Checkpoints over streams."** The whiteboard never narrates the agent
   typing. It narrates the *design*, which is the "diagram updates first" step and happens before any
   code. Building then happens out of sight, and the whiteboard comes back at the checkpoint with a
   settled "here's what changed" walkthrough. You approve the shape on the whiteboard, and approving
   the shape is approving the plan.
2. **"Don't add an in-app diagram editor"** ([CLAUDE.md](../CLAUDE.md)). The whiteboard is read-only
   for the human. You direct by talking or typing; the agent does all the drawing. Mermaid markdown
   stays the durable source of truth. The whiteboard is the conversation about the design, not the
   design document.
3. **Two persistent panels.** The whiteboard is a state the View switches to, like the board or the
   diff, not a third panel. Its input is a small command strip, which is Control.

**Outcome:** a Whiteboard view where you talk through what to build. The agent answers out loud and
sketches it, puts real choices side by side for *you* to decide, and builds once you say yes:
mermaid diagram first, then code, the way it already works. While it builds, the whiteboard is quiet.
When it finishes, the agent walks you through the result on the same whiteboard, with links to the
real diagram and the diff.

---

## Decisions to confirm

These are proposals. Each has a recommendation. They aren't settled until the user agrees, and steps
that depend on one are marked.

1. **The whiteboard is read-only for the human.** You pan, zoom, flip pages and click boxes to
   navigate. You don't draw. *Recommended:* this keeps the "no diagram editor" rule true and keeps
   intent as the human's medium. Revisit only if users ask to point at things.
2. **The canvas is not a source of truth.** At hand-off, the narrator writes a *design brief* (the
   agreed parts, flows and decisions, in words). The builder turns it into mermaid with
   `diagram_edit`, then code. The canvas is saved only so the conversation survives a restart
   (`.codeswim/whiteboard/`). *Recommended:* this avoids a second diagram format competing with
   mermaid.
3. **The narrator runs through opencode, not a direct API call.** It would be a dedicated `narrator`
   agent in the sidecar config (its own prompt, every tool disabled), called in hidden sessions.
   *Recommended:* this keeps two existing rules: every model call goes through opencode, and the key
   never leaves its auth store. Phase 0 checks this is fast enough. Fallback: a main-process call to
   `api.unbiased.ai`, which needs a decision about holding the key in main.
4. **Building starts only on an explicit yes.** The narrator ends a design discussion by asking
   ("Want me to build this?"). Its `build` line is honored only if your last message agreed. The
   prototype's rule "the person makes the final decision" carries over to trade-offs, and now to
   building too.
5. **It's a new workspace view, "Whiteboard".** It's a header tab next to Explore / Plan / Agents,
   because it's a way of working, like the board. It is not a file view.

---

## Design

```
 you ── voice / text ──▶ Narrator (opener + main, hidden opencode sessions)
                              │ JSON lines: say · draw · page · build
                              ▼
                     Whiteboard view ── speaks each sentence while drawing it (tldraw, read-only)
                              │
                 "build" ─────┴──── only after you agree
                              ▼
                     Builder (existing agent session: diagram_edit → code; hidden, no narration)
                              │ session.idle + diagram before/after + changed files
                              ▼
                     Narrator in walkthrough mode ──▶ Whiteboard: "here's what I built"
                                                      + links: open diagram · open diff
```

### The line protocol

The prototype's format, unchanged except for two additions. One JSON object per line.

```ts
type Line =
  | { say: string }                                       // one spoken sentence
  | { box: string; at: [col, row]; label: string; color?: Color; shape?: Geo; link?: string }
  | { arrow: [from: string, to: string]; label?: string; back?: boolean }
  | { note: string; at: [col, row] }
  | { group: string; from: [col, row]; to: [col, row]; label: string }
  | { option: string; at: [col, row]; label: string; pros?: string[]; cons?: string[] }
  | { pick: string }                                      // only for what the person chose
  | { page: string }                                      // turn to (or create) a topic's page
  | { highlight: string } | { move: string; at: [col, row] } | { remove: string } | { clear: true }
  | { more: true }                                        // another part follows
  // new in codeswim:
  | { build: string }        // design brief for the builder; honored only after an explicit yes
  | { link: string; to: string }  // box → a workspace file (diagram or source); clicking navigates
```

The `link` field on a box, and the `link` line, connect sketches to real files. A box for "Auth"
links to `architecture/auth.md`, and clicking it opens that diagram in the Diagram view. This is the
deliberate path from the sketch down to the real thing, the "drop to ground truth" the philosophy
asks for.

### Packages and files

- **`packages/whiteboard`** (new; no Electron, no tldraw). Added to `bundledWorkspaceDeps`. It holds:
  - `protocol.ts`: the `Line` types, the tolerant line parser, and translating lines into canvas
    commands. Validation lives here:
    - labels trimmed at a word boundary, with HTML and markdown stripped
    - colors and shapes mapped to tldraw's set (`gray` becomes `grey`, unknown values get a default)
  - `turn.ts`: the turn scheduler from the prototype. It runs the opener and parts at the same time,
    holds drawing commands until the opener has played, keeps the opener to one sentence, drops an
    answer's first sentence when it repeats the opener (keeping its drawing), and plays each
    sentence's drawing while it's spoken. The speech engine and the canvas runner are passed in, so
    it's testable in plain Node.
  - `prompts/`: `system.md`, `opener.md`, `after-opener.md`, and a new `walkthrough.md` for checkpoint
    mode. The speed line goes first in every prompt.
  - `guards.ts`: the rules enforced in code:
    - only clear when the person asked
    - `pick` only names an option that was offered
    - `build` only after a yes
- **Renderer:**
  - `components/WhiteboardView.tsx`: tldraw with `hideUi`, read-only, plus page tabs and a mode
    banner.
  - `whiteboard/runner.ts`: the canvas commands, ported from the prototype's `main.tsx`:
    - `option`/`pick`; when a picked option moves into the design, its comparison is erased
    - `page`; arrows only join boxes on the same page
    - box placement that avoids occupied cells
    - arrows that curve around boxes in their way
    - removing a box also removes its arrows
    - a camera that keeps the drawing in the uncovered area
  - `whiteboard/describe.ts`: the board summary sent with each request: pages, everything on the
    current page in grid terms, and the boxes on other pages.
  - `whiteboard/speech.ts`: a `Speaker` interface with one engine per voice option.
- **Sidecar config:** a `narrator` agent in `OPENCODE_CONFIG_CONTENT` with the whiteboard prompt,
  every tool disabled, and the Pareto model.
- **Command bus:** `whiteboard.ask`, `whiteboard.stop` and `whiteboard.openLink`, so keybindings and
  the agent reach the feature the same way the UI does.

### Narrator sessions

Each question is two hidden sessions, an opener and a main answer, started at the same moment:

- Each request carries the conversation so far plus a `<canvas>` summary.
- Parts after the first continue in the main session.
- On interruption, both requests are aborted and speech stops.
- Sessions are created ahead of time, so a question doesn't wait on `session.create`.

### Speech

- **Out:**
  - Phase 3 starts with the system voices through `speechSynthesis`. This needs no dependencies and no
    CSP change, and macOS has decent voices.
  - Phase 6 adds Kokoro through `kokoro-js` in a worker. Kokoro sounds much better, is the voice in
    the demo, and needs inline phonetic spellings for product names. Its audio comes back as PCM and
    plays through Web Audio, or through `<audio>` with `media-src 'self' blob:` added to the CSP.
- **In:**
  - Typed input from the start. macOS dictation (press fn twice) works in any text field for free.
  - Chrome's `SpeechRecognition` (what the prototype used) relies on a Google service that stock
    Electron doesn't ship. Phase 0 confirms whether it works here; it most likely doesn't.
  - Push-to-talk with local Whisper is Phase 6.
- **Muting** turns the whiteboard into captions only. Sentences still pace the drawing.

### Build hand-off and checkpoint

1. **The narrator emits `{"build": "<brief>"}`, and the app checks it.** The guard confirms the
   person's last message agreed. If it didn't, the line is dropped and the narrator is asked to
   confirm first.
2. **The brief goes to the builder.** The app sends it as a prompt to the workspace's normal agent
   session, the one the Agent panel shows, together with the chosen pages' contents in words. The
   existing harness takes it from there: `diagram_edit` first, then code.
3. **While it builds, the whiteboard is quiet.** The banner says **Building** and nothing animates.
   There are no progress ticks, in line with "ban ambient attention-bait". You can keep talking about
   the next thing on another page.
4. **At the checkpoint, the narrator walks you through it.** On `session.idle` for that session, the
   app collects:
   - the `diagram_edit` calls (files, before and after)
   - the changed files and a diff stat
   - the final assistant message

   It then asks the narrator for a walkthrough turn. That turn goes to a page named for the change,
   shows what changed against the agreed design, links boxes to the edited diagrams, and ends with
   "Open the diagram" / "Open the diff" actions through the command bus.
5. **A stream fix comes first.** Steps 2–4 need `agent.ts` to forward `session.idle`, `session.diff`
   and `file.edited`, and to keep tool `input`/`title` for `diagram_edit` and the edit tools.

---

## Work, in landing order

Each phase ships green and is useful, or at least invisible, on its own.

### Phase 0: Spikes (no user-facing change)

- **tldraw** renders in the renderer under the current CSP. Fonts, icons and translations are
  self-hosted through Vite asset imports, not the CDN. Check that it works with React 19.2 and record
  the license and watermark terms.
- **The `narrator` agent** works through opencode. It must meet all of these:
  - **Speed:** time to first sentence within 1 s of a direct API call.
  - **Prompt isolation:** the global `instructions` (`system.txt`) don't leak into it. If they do, the
    plugin's `experimental.chat.system.transform` must replace them for narrator sessions.
  - **Format:** it follows the JSON-line format.
  - **Concurrency:** two sessions can run at once.
- **Speech:** `speechSynthesis` voices in packaged Electron on macOS; `SpeechRecognition` in Electron
  (expected: unavailable).
- **The harness plugin** loads on opencode 1.18.21 and `diagram_edit` is registered at runtime.
- **Exit:** a short note in this file with the numbers, and Decision 3 confirmed or switched.

### Phase 1: `packages/whiteboard`, pure and tested

Port the protocol, parser, command translation, turn scheduler, guards and prompts from the
prototype, with unit tests:
- parsing, including broken lines and code fences
- `similar()` dedupe
- clearing only when asked
- labels cut at word boundaries
- mapping unknown colors and shapes
- the opener's one-sentence limit
- holding drawing until the opener plays
- `pick` only naming an offered option

### Phase 2: The Whiteboard view, typed and silent

- New `WorkspaceView 'canvas'` (the list of files that changes is in the survey notes below), with the
  read-only tldraw runner, page tabs, a mode banner and a typed command strip.
- Narrator sessions through opencode, with captions instead of speech.
- Box `link` → `nav` command.
- **Ships:** the design conversation, silent.

### Phase 3: Voice

- `speechSynthesis` output; the drawing paced by sentence; mute; interrupt by typing or with Esc.
- Timing logged per turn (first sentence, first drawing) so regressions are visible.

### Phase 4: Agent stream and build hand-off (depends on Decision 4)

- Extend `agent.ts`: the extra events and tool fields from the Design section.
- The `build` line, its guard, the brief to the builder session, and the quiet **Building** state.
- **Ships:** talk it through, say yes, and the existing agent builds it diagram-first.

### Phase 5: Checkpoint walkthrough

- Collect the checkpoint on `session.idle`.
- Add the `walkthrough.md` prompt and a walkthrough page that links to the edited diagrams.
- Add "Open diagram" / "Open diff" actions.
- **Ships:** the full loop.

### Phase 6: Polish

- Kokoro voice (adds `media-src` to the CSP), with a pronunciation table per workspace.
- Push-to-talk with local Whisper.
- A tldraw custom `OptionCard` shape, replacing the box-plus-notes group that the runner currently
  moves and fades by hand.
- Seed the narrator with `overview.md` and the relevant `architecture/` diagrams, so its sketches use
  the project's real names and link to the real files.
- Persist pages in `.codeswim/whiteboard/`.

### Docs, alongside the phases

- `architecture/whiteboard.md` with its own mermaid diagram (the repo treats its diagrams as the
  spec).
- Updates to [architecture/renderer.md](../architecture/renderer.md) and
  [agent-harness.md](../architecture/agent-harness.md).
- The CLAUDE.md "Don't add an in-app diagram editor" rule gets one sentence saying the whiteboard is
  agent-drawn, read-only, and not a source of truth.

**Survey notes, the files that change for a new workspace view:**
- `store.ts:53` (the `WorkspaceView` type)
- `App.tsx` (a Header tab and a `Body` branch)
- `state.tsx` (`set-workspace-view`)
- `commands/nav.ts:394-406` (the schema enum)
- `packages/contract/src/screen-context.ts:45,49`
- `packages/harness/src/tool/app-view.ts:25`
- `api.ts:313`

---

## Explicitly not doing

- **Human drawing or editing on the whiteboard.** It's read-only (Decision 1).
- **Narrating the agent while it codes.** No tool-call commentary and no live file activity. Only the
  design before and the walkthrough after.
- **Multiplayer whiteboards.** The party Durable Object handles chat only, and live board sync is
  itself still a plan ([multiplayer-kanban-board.md](./multiplayer-kanban-board.md)). If a shared
  whiteboard ever happens, it should reuse that op-log design.
- **Narrating the Claude Code tab.** It has no structured event stream.
- **Cloud text-to-speech or model calls from the renderer.** `connect-src` stays loopback-only.

## Open questions

- **tldraw license.** Production builds need a paid key to remove the watermark. Is that acceptable
  for codeswim's distribution, or is a different canvas library worth a spike in Phase 0?
- **Where the conversation's text lives.** It could be the whiteboard's own command strip, as
  proposed, or the Agent panel's chat, so there's one transcript. The second is simpler for users but
  mixes narrator turns into the builder's session view.
- **Should `.codeswim/whiteboard/` be committed?** Useful for sharing a design conversation, but noisy
  in diffs. Proposed: gitignored by default.
- **Pareto through opencode.** If its hidden reasoning is slower inside opencode's prompt assembly,
  is a main-process direct call (and holding the key in main) acceptable? Phase 0 answers this.
- **One narrator per workspace or per page?** A long conversation's history grows. Pages could reset
  the narrator's history and carry over only a summary.

## Verification

- **Unit tests** for `packages/whiteboard` (Phase 1 list) run in `npm test`.
- **Replay tests.** The prototype's capture → curate → replay tooling becomes a fixture:
  - a saved conversation (`tests/fixtures/*.json`) replays through the runner with a fake speaker
  - assertions: no overlapping boxes, every arrow joins boxes on its own page, `pick` only names
    offered options, no `clear` unless the person asked
- **Latency budget, logged per turn:** first spoken sentence ≤ 3 s, no gap > 1 s between parts on the
  codeswim-example questions. Any regression shows up in the per-turn log.
- **CSP:** after any CSP change, check that mermaid still renders in the Diagram view (CLAUDE.md
  records two past regressions of exactly this kind).
- **End to end, by hand, against `codeswim-example`:**
  1. Ask for a feature and agree to a trade-off.
  2. Say "build it".
  3. Confirm `diagram_edit` lands before any code edit and the whiteboard stays quiet while it builds.
  4. Confirm the walkthrough's links open the real diagram and diff.

---

## Implementation status (2026-10-19)

Phases 0–5 are implemented, and most of Phase 6. The recommended option
was taken for each of the five decisions. Building runs through the
workspace's normal agent session, and transcripts stay in the whiteboard's
own strip, not the Agent panel's chat. The spec is
[architecture/whiteboard.md](../architecture/whiteboard.md).

### Phase 0 results

Measured with a real `opencode serve` (1.18.21) against a local mock model
that records each request. Pareto itself wasn't measured: its key lives in
opencode's auth store and the spike didn't read it.

| Check | Result |
|---|---|
| Harness plugin loads | **No, until now.** opencode 1.18 refuses a path plugin without an `id` export ("must export id"), so every harness tool, `diagram_edit` included, was unregistered and the gate was off. Fixed in `plugin.ts`, with a test. |
| Agent with `tools: {"*": false}` | Request carries no tools. |
| Prompt isolation inside the main sidecar | **Fails.** opencode appends instruction files, the env block and the workspace's AGENTS.md/CLAUDE.md (and `~/.claude/CLAUDE.md`) after the plugin's `experimental.chat.system.transform`, so the hook can't strip them: 34,467 system characters in a workspace with a CLAUDE.md. |
| Narrator in its own `opencode serve` | 7,370 characters (main), 1,351 (opener). No plugin, no instructions, `OPENCODE_DISABLE_CLAUDE_CODE=1`, empty working directory, same auth store. |
| Concurrency | Opener and main requests reach the model in the same millisecond. |
| opencode overhead | About 35 ms per request once warm; the first request into a new directory pays about 700 ms, hidden by pre-created sessions. |
| Auto-titling | A preset session title skips opencode's extra title request. |
| tldraw 5.5.2 | Renders under the current CSP with React 19.2, assets bundled by Vite. **Packaged builds without a license key hide the editor after 5 s** (file:// counts as production). Dev works. |
| Speech | `speechSynthesis` needs no CSP change. `SpeechRecognition` was not wired; typed input plus macOS dictation is the input path. |

**Decision 3, adjusted:** the narrator still goes through opencode and the
key still never leaves its auth store, but in a second, app-wide opencode
process (`startNarratorSidecar`) rather than as an agent inside the coding
agent's sidecar.

### Where the build differs from the plan

- The view is named `'whiteboard'`, not `'canvas'`.
- Layout rules (placement, arrow routing, option/pick bookkeeping, the canvas
  summary) live in a pure `BoardModel` in `packages/whiteboard`; the tldraw
  file only animates its effects. That's what lets the replay tests check
  "no overlapping boxes" and "arrows stay on their page" in Node, and makes
  the canvas library swappable.
- Prompts are TS string modules, not `.md`, so main, renderer and tests
  bundle them with no loader config.
- `whiteboard.ask` is human-only on the command bus; an agent able to ask
  could say yes to a build on the person's behalf.
- Replay fixtures are the prototype's four captured game-architect
  conversations, converted to the line protocol.

### Verified

- Unit and replay tests: whiteboard package 65, harness 71, desktop 323 (all
  green), typecheck and production build green.
- Live, in headless Chromium against real opencode servers with a mock model:
  a two-turn design conversation (opener first, trade-off, pick), then "yes,
  build it". The harness wrote the diagram via `diagram_edit` and only then
  the code (a mock run without a valid diagram showed the gate blocking
  `write`). The walkthrough landed on a "Built: …" page with Open the
  diagram / Open the diff, the diff view showed both files, the board
  survived a reload, and a linked box opened the real diagram with mermaid
  rendering.

### Not done yet

- **Real-model latency.** The ≤ 3 s first-sentence budget needs a run on
  Pareto. Per-turn timings are logged to the console and shown under the
  command strip.
- **tldraw license.** Needs a decision: buy a key (`VITE_TLDRAW_LICENSE_KEY`)
  or swap the canvas (only `tldraw-canvas.ts` changes).
- **Phase 6:** local-Whisper push-to-talk and the custom `OptionCard`
  shape. The Kokoro voice (with a per-workspace pronunciation table), seeding
  the narrator with the project's diagrams, and persisting pages in
  `.codeswim/whiteboard/` are done.

### Kokoro voice (2026-10-19)

Measured on this Mac (Apple Silicon), Kokoro-82M through kokoro-js 1.2.1:

| Runtime / precision | Download | One sentence (3–4 s of audio) |
|---|---|---|
| onnxruntime-node, fp16 (chosen) | 163 MB | 0.45–0.6 s (7–8x real time) |
| onnxruntime-node, fp32 | 325 MB | 0.4–0.6 s |
| onnxruntime-node, q8 | 92 MB | 1.0–1.5 s |
| onnxruntime-node, q4 | 305 MB | 0.5–0.6 s |

It runs in an Electron utility process rather than the renderer. The native
runtime is about twice as fast as WebAssembly would be, and main can download
the model without opening the renderer's CSP. Checked in the packaged app:

- The real download and load took 23 s, then the banner cleared.
- An installed voice loads by itself in about 1 s.
- Sentences come back over IPC as Float32Array and play through Web Audio:
  1.5 s for the first sentence after load, about 0.67 s after that.

Packaging: onnxruntime-node ships only the build OS's binaries, 65 MB on
macOS (both architectures) instead of 210 MB. The same check found and fixed
a packaged-build bug: tldraw's asset formatter turned `file://` URLs into
`file:///file:///…`, so the canvas fonts and translations failed to load
outside dev.

### Bundled speech models and speech mode (2026-10-24)

Speech mode (the sound-wave button) adds local speech recognition: Whisper
base.en, q8, 77 MB, about 0.4 s per 5 s sentence. Both it and the Kokoro
voice now ship inside the app instead of being offered as downloads, which
adds 239 MB to the package (1.3 GB unpacked on macOS). Checked in an
unpacked, unsigned build with a fresh profile: both report installed before
anything runs, the voice loads in 0.7 s and Whisper in 0.6 s, a sentence
synthesizes in 0.4 s and transcribes in 0.4 s, speech mode goes straight to
listening, and nothing is written to the profile. Kokoro q8 (92 MB) would
save 70 MB but is half the speed, so fp16 stays.

### The page beside the board (2026-10-20)

The narrator can now talk about a live web page in the new browser panel
([architecture/renderer.md](../architecture/renderer.md#browser-panel)): "here's
your landing page, the buttons are 220 pixels wide". It points at elements
while it talks, and after a build it reports measured changes.

- **The `<page>` block.** Requests carry an outline of the open page: elements
  by text, with sizes where they matter. It costs no extra model call.
- **Measured changes.** The page is outlined before a build and again after a
  reload. The difference goes into the checkpoint, so the walkthrough says
  "260 pixels now, up from 220" from a measurement.
- **Follow-ups.** For two questions after a walkthrough, "make them even wider"
  builds without a separate yes. A board restored from disk never gets that
  window.

Checked in the built app with real `opencode serve` sidecars, scripted mock
models, and a real dev page:

1. The narrator pointed at the heading and both buttons (the rings showed on
   the page).
2. "Make the sign up buttons wider" before any build asked for a yes.
3. "Yes" built it: a diagram, then the CSS. The walkthrough said 220 → 260,
   matching the page.
4. "Actually, make them even wider" built straight away: 260 → 300.
5. A second run on the saved board confirmed the restored build doesn't skip
   the yes.

The first real try exposed a gap: "show me the landing page" with no dev
server running got "I can't open it from here". The narrator can now start
the project's dev server (`{"start":"dev"}`, dev-server runs only and never
over another running script). The app opens the server's address beside the
board and asks the question again. Checked live with a real `npm run dev`
and the panel closed. That run also caught the script runner switching away
from the whiteboard to the output view; a run the whiteboard starts now stays
in the background.

Not done: the real model's choice of point targets and its wording are
untested (the mock was scripted). Pareto has to show it quotes element text
exactly and keeps to the measured numbers.

### One chat, and reading code (2026-10-24)

The separate whiteboard chat is gone. While the board is on screen, the
Agent panel's chat talks to the narrator, and its replies land in the same
thread as the agent's. The narrator also answers from real code now: files
you name are read into the request, and anything else goes to a hidden
read-only agent session (`glob`, `grep` and `read` only; opencode enforces
the per-message tools map). The narrator reports what it found. Checked live
in the built app with real `opencode serve` sidecars and scripted mock
models: a named file was answered from its contents, a "where is…" question
went to the read-only agent and came back, the Agent switch reached the
agent, and the hidden session was gone afterwards.
