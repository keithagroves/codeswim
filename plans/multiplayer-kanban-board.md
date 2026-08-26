# Multiplayer kanban board over the party Durable Object

## Context

The kanban board is a single JSON file — `.codeswim/board.json`, read and written by
[domain-kanban](../packages/domain-kanban/src/kanban.ts) and rendered by
[KanbanView.tsx](../apps/desktop/src/renderer/src/components/KanbanView.tsx). It is git-tracked
(`git ls-files .codeswim/board.json`), so it is already *shared* — asynchronously, through commits.
What it isn't is *live*.

The GitHub Projects integration can't fill that gap, and the reason is structural, not effort:

- **Poll-only.** `syncKanbanWithGitHub` fires three `gh` subprocess calls when a human clicks sync
  ([kanban.ts:264](../packages/domain-kanban/src/kanban.ts#L264)). There is no subscription, and
  adding one means GraphQL subscriptions against a rate-limited API for maybe-10-second latency.
- **Write-back is a keyhole.** `moveGitHubKanbanItem` edits exactly one single-select field
  ([kanban.ts:274](../packages/domain-kanban/src/kanban.ts#L274)). Retitles, priority changes and
  `dependsOn` edits go nowhere.
- **Full-replace merge.** `mergeGitHubItems` rebuilds every GitHub-backed card on each sync
  ([kanban.ts:167](../packages/domain-kanban/src/kanban.ts#L167)). Two people syncing concurrently
  overwrite rather than merge.

Meanwhile the collaboration substrate already exists and is deployed. `CodeswimRoom`
([party/codeswim.ts](../party/codeswim.ts)) is a per-repo Durable Object with GitHub-collaborator
auth, room ids derived from the origin remote hash (`roomIdForSlug` in
[party/auth.ts](../party/auth.ts)), a websocket surface, a plain-HTTP surface, and presence that
already tracks *what file each user is looking at* (`ChatUser.viewing`,
[chat.ts:12](../packages/contract/src/chat.ts#L12)).

**Outcome:** the board syncs live between everyone with the repo open, `board.json` stays the
on-disk source of truth so the agent harness and Run all keep working offline, and GitHub Projects
keeps its existing role as the durable cross-tool record rather than being promoted into a
real-time bus.

---

## Decisions taken

**1. The DO is a wire, not a store.** `board.json` remains authoritative on disk. Clients apply
remote ops and write the file; the DO holds an op log for ordering and catch-up. This is what keeps
[kanban-run-all](../apps/desktop/src/renderer/src/kanban-run-all.ts) and the agent's board access
working with no network.

**2. One worker, one DO class, one websocket.** The board rides `CodeswimRoom` and the existing
socket. Splitting into a second worker would require a `script_name` binding, which
[cannot be exercised across two `wrangler dev` sessions](https://developers.cloudflare.com/workers/development-testing/multi-workers/)
— it needs a single dev command with multiple `-c` configs. Not worth it. A second DO *class* in the
same worker stays available later if the board needs a different lifetime than the room; that's a
`migrations` tag away and needs no code restructuring.

**3. GitHub and the DO are not mirrors of each other.**

| | GitHub Projects | Durable Object |
|---|---|---|
| role | durable cross-tool record | live session |
| latency | on demand | sub-second |
| audience | PMs, triage, people without codeswim open | people in the app right now |
| direction | one-way import + status push (unchanged) | full read/write |

GitHub-backed cards (`card.github?.itemId`) are **excluded from the op log**. They are owned by the
sync path. This kills the three-way merge problem at the design level instead of solving it.

**4. Collab room only.** The board is repo state; the `public` room is display-name-only and must
not see or mutate it. Board frames are rejected outside `mode=collab`.

**5. Card creation/mutation requires GitHub-collaborator identity, not just room membership.**
`mode=collab` already gates the websocket to listed repo collaborators
([auth.ts:46](../party/auth.ts#L46)), so `card-add`/`card-edit`/etc. sent over that socket inherit
that check for free. The gap is the agent HTTP path raised in the open questions below: if
`board-op` POSTs are ever accepted there, that endpoint must run the same collaborator check as the
websocket upgrade, not just "has a valid session token." The concern is an agent (or anything
scripting the HTTP surface) creating/moving cards on someone else's behalf without being a verified
collaborator itself. `appendOp` should treat the authenticated identity as a hard precondition, not
something inferred from the caller.

Why this matters more than an ordinary "who can edit shared state" check: a card's title/description
is exactly the prompt handed to an agent when it's run (`kanban.runCard`/`kanban.runColumn`, see
`commands/kanban.ts` — an isolated worktree, but still repo-scoped write/commit access). A card added
by anyone other than a verified collaborator is a prompt-injection vector, not just a spam/vandalism
one — `card-add`/`card-edit` need the collaborator check to be a hard server-side precondition for
that reason specifically, not merely a niceness-of-attribution one. This is the multiplayer/room
analogue of the local decision already made in `commands/kanban.ts` (`kanban.save`/`runCard`/
`runColumn` are all `agent: 'never'` — an agent can't create or edit a card locally either, for the
same reason).

---

## Design

```
KanbanView ──persist()──→ board.json  (unchanged, still the disk truth)
     │                        ▲
     │ local op               │ apply remote op
     ▼                        │
  useBoardSync ──ws──→ CodeswimRoom ──→ SQLite op log (seq-ordered)
                          │
                          └──broadcast──→ other clients
```

### BoardOp

Ops are the mutations `KanbanView` already performs, named. In `packages/contract/src/kanban.ts`:

```ts
export type BoardOp =
  | { kind: 'card-add'; card: KanbanCard }
  | { kind: 'card-edit'; cardId: string; patch: Partial<Omit<KanbanCard, 'id' | 'github'>> }
  | { kind: 'card-move'; cardId: string; columnId: string }
  | { kind: 'card-delete'; cardId: string }
  | { kind: 'column-add'; column: KanbanColumn }
  | { kind: 'column-edit'; columnId: string; patch: Partial<Omit<KanbanColumn, 'id'>> }
  | { kind: 'column-delete'; columnId: string }
  | { kind: 'title-set'; title: string }

export interface SequencedOp {
  seq: number        // server-assigned, monotonic per room
  op: BoardOp
  userId: string     // who did it, for presence attribution
  at: number         // server clock
}

export function applyBoardOp(board: KanbanBoard, op: BoardOp): KanbanBoard
```

`applyBoardOp` is pure and lives next to `normalizeKanbanBoard`, so it is testable under plain Node
and reusable by both sides. Conflict policy is **last-writer-wins per field**, with the server's
`seq` as the total order — `card-edit` merges `patch` into the card, so two people editing different
fields of the same card both survive. This is deliberately not a CRDT: kanban ops are small and
near-commutative, and card-level LWW is indistinguishable from correct for the number of people who
will ever have one repo open.

Ops naming a card or column that doesn't exist are **no-ops, not errors** (delete/edit races). Ops
touching a card with `github.itemId` are rejected client-side before send and ignored server-side.

### Server

`CodeswimRoom` gains a board section beside the chat one:

- **Storage.** SQLite is already enabled (`new_sqlite_classes: ["CodeswimRoom"]` in
  [wrangler.jsonc](../wrangler.jsonc)) but unused — chat history is in-memory. Add one table:
  `board_ops(seq INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, at INTEGER, op TEXT)`.
- **Ordering.** All board writes funnel through one private `appendOp` method, mirroring how
  `postMessage` is the single writer for chat ([codeswim.ts:241](../party/codeswim.ts#L241)).
- **Compaction.** Keep a `board_snapshot` row (full `KanbanBoard` + the seq it reflects). Every N
  ops (start at 200), fold the log into the snapshot and delete folded rows. Without this the log
  grows unboundedly for a long-lived repo.
- **Hibernation.** `static options = { hibernate: false }` today, because chat history lives in
  memory ([codeswim.ts:83](../party/codeswim.ts#L83)). Board state is in storage, so it doesn't
  force that either way — but do **not** flip hibernation on as part of this work. Chat history and
  the presence roster are still in-memory and would be lost. Note it as a follow-up.

### Protocol

Extend the existing unions in [chat.ts](../packages/contract/src/chat.ts). Client → server:

```ts
| { type: 'board-op'; op: BoardOp }
| { type: 'board-sync'; sinceSeq: number }   // catch-up after reconnect
```

Server → client:

```ts
| { type: 'board-init'; board: KanbanBoard; seq: number }   // sent with `init` on collab rooms
| { type: 'board-ops'; ops: SequencedOp[] }                 // broadcast + catch-up reply
| { type: 'board-reset'; board: KanbanBoard; seq: number }  // sinceSeq predates compaction
```

`parseClientMessage` must validate these the same shallow way it validates the rest — it is the
trust boundary for anything arriving over the wire.

### Client

New hook `apps/desktop/src/renderer/src/chat/board-sync.ts`, sitting alongside
[connection.ts](../apps/desktop/src/renderer/src/chat/connection.ts) and sharing its socket.

The tricky part is that `KanbanView` already has three writers racing for the board — `persist`,
the file watcher reload, and `moveCardIsolated`'s promise chain — coordinated by
`mutationGeneration` and `boardRef` ([KanbanView.tsx:329-345](../apps/desktop/src/renderer/src/components/KanbanView.tsx#L329-L345)).
Remote ops become a fourth. They must go through the *same* serialization:

- Local mutation → optimistic `setBoard` (as today) → `persist` to disk → send op.
- Remote op → enqueue on `writeQueueRef` → `applyBoardOp(boardRef.current, op)` → `persist`.
- Never send an op that arrived from the server (no echo loop). The server does not rebroadcast to
  the originating connection; the client also drops ops whose `userId` is its own.

### Offline and reconnect

Track `lastSeq` (persisted in `board.json` under a `sync` key, so it survives an app restart) and a
local pending-op queue held in memory.

- **Disconnected:** ops apply locally and queue. The board keeps working exactly as it does today.
- **Reconnect:** send `board-sync { sinceSeq: lastSeq }`, apply the returned ops, *then* replay the
  pending queue. Local edits land after remote ones — last-writer-wins gives the reconnecting user's
  intent priority, which is what they expect since they just made those edits.
- **Compaction gap:** if `sinceSeq` is older than the snapshot, the server replies `board-reset`
  with the full board. The client takes it, then replays pending ops on top.
- **First join ever:** `board-init`. If the room has no snapshot and no ops, the joining client
  seeds it from its local `board.json` — first person in the room establishes the board.

### Presence

Nearly free, and the part that actually sells the feature. `ChatUser.viewing` is already a
posix-relative path driving "Sam is viewing architecture/auth.md". Widen it:

```ts
viewing: string | null                       // unchanged
editingCardId?: string | null                // new
```

`KanbanView` sets `editingCardId` on drag start and card-editor open, clears on drop/close. Render
it as an avatar on the card. No new transport — it rides the existing `viewing` frame and
`broadcastPresence`.

---

## Work order

Each step ships green and useful on its own.

1. **`applyBoardOp` + `BoardOp` in contract.** Pure, unit-tested, no wire. Refactor `KanbanView`'s
   existing mutations to go through it. Zero behavior change — this is the step that proves the op
   vocabulary covers what the UI actually does.
2. **Server op log.** SQLite table, `appendOp`, `board-sync` handling, compaction. Test against the
   fake Server/Connection harness in [codeswim.test.ts](../party/codeswim.test.ts).
3. **Protocol types + validation** in `chat.ts`, both parsers.
4. **`board-sync` hook** on the shared socket, wired into `KanbanView`'s write queue. Live sync
   works at this point.
5. **Offline queue + reconnect/reset.**
6. **Card presence.**
7. **Docs:** update [architecture/party.md](../architecture/party.md) — it currently documents the
   DO as chat-only, including the mermaid diagram and the "history is not persisted to storage yet"
   note.

## Open questions

- **Does the board room need to differ from the chat room?** Same id, same auth, same people today.
  Assuming yes-same until something forces otherwise.
- **`.codeswim/board.json` in git, once live sync exists.** Two people live-syncing *and* committing
  a machine-written file will hit merge conflicts. Options: leave it (conflicts are rare if card
  order is stable), gitignore it once a room is connected, or commit only on explicit action. Worth
  deciding before step 4 ships to more than one user; not blocking earlier steps.
- **Should the agent's board access go through the DO's HTTP surface?** The harness reads the file
  today, which is right for worktrees. But an agent moving a card to "Done" during Run all should
  probably show up live for everyone watching. The HTTP POST path exists
  ([party/http.ts](../party/http.ts)) and could take ops the same way it takes chat messages. If it
  does, it must enforce the same collaborator check as the websocket (decision 5) — no bypass via
  HTTP just because it's a different transport.
