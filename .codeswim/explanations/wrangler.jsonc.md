---
name: Wrangler Config
description: Cloudflare Workers configuration for the codeswim chat PartyServer worker — Durable Objects, auth, dev port, and observability.
tags: [cloudflare, chat, infrastructure]
---

## Purpose

Configures the `wrangler` CLI to deploy and develop the chat PartyServer worker at [`party/codeswim.ts`](../party/codeswim.ts). In production the worker runs on your own Cloudflare account's `workers.dev` subdomain; locally it runs via `wrangler dev`. The config controls what the worker is called, where its entry point lives, how it authenticates connections, and which Durable Object it binds for per-repo room state.

## Responsibilities

- Declare the worker name (`codeswim`) and compatibility date.
- Point `main` at `party/codeswim.ts` so Wrangler knows what to bundle.
- Set the `REQUIRE_AUTH` environment variable to `"true"` by default — the worker rejects unauthenticated WebSocket connections in production. Local dev overrides this to `"false"` via the `party:dev` npm script.
- Bind a Durable Object (`CodeswimRoom`) backed by SQLite storage, used by the worker to persist room chat history.
- Define a migration (`v1`) that creates the `CodeswimRoom` SQLite class on first deploy.
- Set the local dev port to `8788` (off Wrangler's default `8787` which the chrome-bridge daemon occupies).
- Enable Cloudflare observability (tracing and metrics) for the deployed worker.

## Dependencies and side effects

- Consumed by `wrangler` CLI commands (`wrangler dev`, `wrangler deploy`) — not by application code directly.
- The dev port `8788` must stay in sync with the client default in [`src/renderer/src/chat/connection.ts`](../src/renderer/src/chat/connection.ts).
- The `REQUIRE_AUTH` var is read by the worker's `onConnect` to decide whether to hold new connections until an `{type:'auth'}` frame arrives.
- The `$schema` reference to `node_modules/wrangler/config-schema.json` provides IDE autocomplete; broken if `wrangler` is not installed.
- No runtime imports by the renderer or main process — it is a deployment artifact, not a module.

## Failure modes

- **Port conflict** — if something else (e.g. the chrome-bridge daemon) binds `8788`, `wrangler dev` fails to start. Change via the `dev.port` field and the corresponding client default.
- **Missing Durable Object migration** — deploying without a migration for a new SQLite class causes Wrangler to error. Every `new_sqlite_classes` entry needs a corresponding migration entry.
- **`REQUIRE_AUTH` mismatch** — if the env var is `"true"` but the worker has no auth flow (e.g. no `GITHUB_CLIENT_ID` configured in the deployed env), all connections are held and eventually timeout. Production deployments must supply the client ID.
- **Schema resolution** — `$schema` is a dev-only convenience; resolving it is not required for deploy.

## Related diagrams and decisions

- No diagram currently covers the chat infrastructure. The `party/codeswim.ts` worker is the runtime this config serves.
- The dev port `8788` offset from Wrangler's default `8787` is a convention established to avoid conflict with the chrome-bridge daemon (see `src/renderer/src/chat/connection.ts`).
