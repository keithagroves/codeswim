# Unbiased partner integration guide

*For coding-agent maintainers adding "Sign in with Unbiased" to their tool.
Shareable as-is. Last verified against production 2026-09-21.*

## What you are building

A `login` command (or button) that gets an Unbiased API key onto your user's
machine without the user ever copying a key by hand:

1. Your tool asks Unbiased for a short code and opens the user's browser.
2. The user signs in or creates an Unbiased account, sets up a plan, and
   clicks **Approve**.
3. Your tool receives a freshly minted Pareto API key and stores it locally.
4. Every request your tool makes to `https://api.unbiased.ai` carries that key.

The protocol is the standard OAuth 2.0 **device authorization grant**
([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628)), the same shape as
`gh auth login`, `az login` or `aws sso login`. It works over SSH, in
devcontainers and on remote boxes because nothing has to redirect back to the
machine your tool runs on. Both new and existing Unbiased users go through the
same flow; existing users just sign in and approve.

Users who sign up through your tool are attributed to you for the referral
program. Attribution happens automatically on our side from the approval
itself. There is nothing to add to URLs or requests.

## What you receive from Unbiased

| Item | Notes |
| --- | --- |
| `client_id` | An opaque public identifier for your tool, e.g. `dhTH_VbRdB88tgW-m1HWiw`. Ship it in your binary or config. It is public by design and carries no secret, so it can live in an open-source repo. |
| Authorization server | `https://platform.unbiased.ai` |
| API gateway | `https://api.unbiased.ai` |
| Conformance kit | A small Node script that drives your client against a mock server and checks the polling rules below. See "Conformance kit". |

There is **no client secret** and **no redirect URI**. If your OAuth library
insists on one, you are configuring the wrong grant type.

## The flow

Both endpoints accept `application/x-www-form-urlencoded` (shown) or JSON
bodies under 8 KB and always answer JSON. Errors follow RFC 6749 §5.2:

```json
{ "error": "<code>", "error_description": "<human-readable reason>" }
```

### Step 1: request a device authorization

```sh
curl -X POST https://platform.unbiased.ai/api/oauth/device_authorization \
  -d client_id=YOUR_CLIENT_ID \
  -d device_name="$(hostname)"
```

| Param | |
| --- | --- |
| `client_id` | Required. |
| `device_name` | Optional, up to 100 characters; a longer name is truncated, not rejected. Display only. If the user chooses to create a new workload during approval, its name is derived from your partner name plus this value. A hostname is a good choice. |

Response:

```json
{
  "device_code": "…43 chars, your private handle for this authorization…",
  "user_code": "BCDF-GHJK",
  "verification_uri": "https://platform.unbiased.ai/activate",
  "verification_uri_complete": "https://platform.unbiased.ai/activate?user_code=BCDF-GHJK",
  "expires_in": 900,
  "interval": 5
}
```

| Error | HTTP | Meaning |
| --- | --- | --- |
| `invalid_request` | 400 | Missing or malformed `client_id`. |
| `invalid_client` | 401 | This `client_id` is unknown or has been disabled. Tell the user to update your tool. |
| `temporarily_unavailable` | 429 or 503 | 429: too many starts from this IP, wait a minute. 503: the platform is temporarily unable to start sign-ins, retry shortly. |

### Step 2: show the code and open the browser

Print the code and the URL, then open `verification_uri_complete`:

```
Open https://platform.unbiased.ai/activate and enter the code

    BCDF-GHJK

Opening your browser… (the code expires in 15 minutes)
```

Always print both, even when you open the browser. Over SSH there may be no
browser to open, and the user needs the plain URL and code to type into a
browser on another machine. The `verification_uri_complete` link pre-fills the
code; the user still sees the code on screen and must click Approve.

What the user sees on our page, in order:

1. Sign in, or create an account (the same sign-in as the Unbiased dashboard).
2. A confirmation screen showing your name and logo, the code (to match
   against their terminal) and a warning to approve only a sign-in they
   started themselves.
3. For a new account: a choice of plan, Personal at $10/month or Personal Max
   at $100/month, then a card. A new account opened through a partner sign-in
   is a subscription; pay-as-you-go business accounts are set up from the
   Unbiased dashboard, not here. Existing accounts of any type skip this. An existing
   business account with no credit balance is asked to add credit here so
   the key can serve requests immediately.
4. Which of their workloads the key is for, or "create a new workload for
   this tool". Most users pick the default.
5. **Approve** or **Deny**.

The whole thing fits comfortably inside the 15-minute code lifetime, including
card entry. Your tool does not need to know which path the user took.

### Step 3: poll for the token

```sh
curl -X POST https://platform.unbiased.ai/api/oauth/token \
  -d grant_type=urn:ietf:params:oauth:grant-type:device_code \
  -d device_code=DEVICE_CODE \
  -d client_id=YOUR_CLIENT_ID
```

Poll once every `interval` seconds. **Sleep before the first poll.** In the
order a client meets them:

| `error` | HTTP | Meaning | What your tool does |
| --- | --- | --- | --- |
| `authorization_pending` | 400 | Not approved yet. | Keep polling. |
| `slow_down` | 400 | You polled too soon. | Add 5 seconds to your interval permanently, keep polling. A 429 `slow_down` is the per-IP limit; treat it the same way. |
| `temporarily_unavailable` | 503 | Platform hiccup; the request did not reach the grant. | Keep polling. |
| `access_denied` | 400 | The user clicked Deny. | Stop. Tell the user. |
| `expired_token` | 400 | 15 minutes passed. | Stop. Offer to start again. |
| `invalid_grant` | 400 | Unknown code, wrong client, or a code that was already redeemed (see below). | Stop. Offer to start again. |
| `invalid_request`, `unsupported_grant_type` | 400 | Your request is malformed. | Fix the client. |
| `invalid_client` | 401 | Your partnership or this `client_id` was disabled while the code was pending; the sign-in the user is looking at can no longer complete. | Stop. Tell the user to update your tool. |
| `server_error` | 500 | Key issuance failed after approval. | Stop. Offer to start again. |

Success comes exactly once:

```json
{
  "access_token": "sk_pareto_…",
  "token_type": "bearer",
  "organization_id": "…",
  "workload_id": "…",
  "workload_name": "codeswim-bdjs-macbook",
  "key_name": "Brian · Codeswim · 2026-09-21",
  "user": { "id": "approving-member-id", "name": "Alex Smith" }
}
```

`access_token` is the API key. The other fields exist so you can label what you
stored ("Signed in to workload codeswim-bdjs-macbook"). `user` is the member who
approved this authorization: an organization-scoped ID and profile name for
display. `name` is null when unavailable. This is a redemption-time snapshot,
not an OIDC ID token, and does not change the key's authority. Treat `user` as
optional for compatibility.

#### The one rule that matters: never send a token poll twice

The platform mints the key the moment it answers your poll with a 200, and it
does not keep a copy. It therefore cannot tell "my response got lost, please
resend" from "an attacker replayed the request". **Any further poll of a
device code after its 200 revokes the key that was just issued** and answers
`invalid_grant` with a description saying why.

Consequences for your client:

- Send every token request exactly once. **Disable automatic retries** on this
  call. Most HTTP libraries retry idempotent-looking POSTs on connection
  errors; turn that off for this endpoint.
- If a poll fails at the transport level (timeout, connection reset), end the
  flow with "connection lost, please run login again" rather than retrying.
  The restart costs the user ten seconds. A retry might revoke a key the user
  never saw, or worse, leave one live that nobody holds.
- After a 200, stop polling. Do not "confirm" with another request.

The conformance kit checks all of this from the wire.

### Step 4: store the key

- Write it to a file with owner-only permissions (`0600`), for example
  `~/.yourtool/credentials.json`, or the OS keychain.
- Never put it in a URL, a log line, crash telemetry or your own servers. The
  key belongs to the user and the platform; your tool is only the courier.
- On `logout`, delete the local copy. Users revoke keys from the Unbiased
  dashboard under **Keys**, where each sign-in appears as
  `<user> · <your partner name> · <date>`. Every login mints a new key, so a
  second `login` on the same machine simply replaces the stored one.

### Step 5: use the key

The gateway at `https://api.unbiased.ai` speaks three dialects. Use whichever
your tool already speaks and set the model to `pareto`.

| Dialect | Endpoint | Auth header |
| --- | --- | --- |
| OpenAI Chat Completions | `POST /v1/chat/completions` | `Authorization: Bearer <key>` |
| OpenAI Responses | `POST /v1/responses` | `Authorization: Bearer <key>` |
| Anthropic Messages | `POST /v1/messages` | `x-api-key: <key>` (Bearer also accepted) |

```sh
curl https://api.unbiased.ai/v1/chat/completions \
  -H "Authorization: Bearer $UNBIASED_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"pareto","messages":[{"role":"user","content":"say ok"}]}'
```

Streaming works on all three. Keys begin with `sk_`.

## Reference implementation

Pure `fetch`, no dependencies. This is the shape the conformance kit expects
and mirrors the client shipped in the Unbiased desktop app.

```ts
const PLATFORM = "https://platform.unbiased.ai";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(path: string, params: Record<string, string>) {
  const res = await fetch(`${PLATFORM}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(params).toString(),
    // No retries. See "never send a token poll twice".
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

export async function login(clientId: string, deviceName: string) {
  const start = await post("/api/oauth/device_authorization", { client_id: clientId, device_name: deviceName });
  if (start.status !== 200) throw new Error(`could not start sign-in: ${start.body?.error ?? start.status}`);
  const grant = start.body;

  console.log(`Open ${grant.verification_uri} and enter the code\n\n    ${grant.user_code}\n`);
  openBrowser(grant.verification_uri_complete); // your platform's "open URL" call

  let interval = Math.max(1, grant.interval);
  let elapsed = 0;
  for (;;) {
    await sleep(interval * 1000); // sleep FIRST
    elapsed += interval;
    if (elapsed > grant.expires_in) throw new Error("the sign-in code expired, run login again");

    let r;
    try {
      r = await post("/api/oauth/token", { grant_type: GRANT_TYPE, device_code: grant.device_code, client_id: clientId });
    } catch {
      throw new Error("lost the connection while waiting, run login again"); // never retry
    }
    // A 200 whose body does not parse falls through to `default:` below and ends
    // the flow: the key was minted and is lost, so "restart login" is the only
    // correct response — never a retry of this request.
    if (r.status === 200 && r.body?.access_token) {
      return { apiKey: r.body.access_token as string, workloadName: r.body.workload_name as string };
    }
    switch (r.body?.error) {
      case "authorization_pending": continue;
      case "slow_down": interval += 5; continue;
      case "temporarily_unavailable": continue;
      case "access_denied": throw new Error("sign-in was declined in the browser");
      case "expired_token": throw new Error("the sign-in code expired, run login again");
      default: throw new Error(`sign-in failed: ${r.body?.error_description ?? r.body?.error ?? r.status}`);
    }
  }
}
```

Suggested user-facing copy for the terminal states:

| Situation | Copy |
| --- | --- |
| `invalid_client` at start | "This build isn't registered for Unbiased sign-in. Please update <tool>." |
| `access_denied` | "Sign-in was declined in the browser." |
| `expired_token` | "The sign-in code expired before it was confirmed. Run `<tool> login` again." |
| transport failure while polling | "Lost the connection while waiting for approval. Run `<tool> login` again." |
| `invalid_grant` mentioning a re-poll | This is a bug in your client's retry configuration, not a user error. See the rule above. |

## Conformance kit

We send you a directory containing a self-contained Node script. It starts a
scripted mock of the two endpoints on a local port, drives your client through
six scenarios and checks request counts and timings on the wire:

1. Happy path, and no request of any kind after the 200.
2. `slow_down` adds 5 seconds.
3. `access_denied` is terminal.
4. Expiry ends polling.
5. A transport failure is terminal, never retried.
6. `invalid_client` at start fails cleanly with no token poll.

You supply an adapter: a module that default-exports an object with two
functions mapping onto your client.

```ts
import type { ConformanceAdapter } from "./adapter";

const adapter: ConformanceAdapter = {
  name: "codeswim",
  async start({ baseUrl, clientId, deviceName }) {
    // call your step-1 code against baseUrl; return { ok: true, grant } or { ok: false, code }
  },
  async poll({ baseUrl, clientId, grant }) {
    // call your step-3 loop against baseUrl; return { ok: true, accessToken, ... } or { ok: false, code }
  },
};
export default adapter;
```

Your client must accept a base URL override for this to work (an environment
variable is fine). Then:

```sh
npx tsx run.ts --adapter ./adapters/codeswim.ts
```

Exit code 0 means conformant. It takes about half a minute and touches no real
Unbiased systems. Run it in your CI if you can.

## Frequently asked

**Does the user need an Unbiased account first?** No. The verification page
offers account creation. Existing users sign in and approve.

**What plan does the user end up on?** A new account picks
Personal ($10/month) or Personal Max ($100/month) on the verification page; a
pay-as-you-go business account is not opened through a partner sign-in (people
set those up from the dashboard). An existing account of any type keeps
whatever it has. Your tool sees only the key.

**Multiple machines.** Run login on each. Every login mints its own key, and
the user's dashboard lists them all by device.

**The user closed the browser.** Your poll keeps returning
`authorization_pending` until the code expires at 15 minutes; then
`expired_token`. Offer to start again.

**Rate limits.** At least 30 starts and 120 token polls per minute per source
IP on the sign-in endpoints. A single client honouring `interval` never
approaches these. A shared CI egress IP might; back off on 429 as the table
says. On `api.unbiased.ai`, subscription traffic also shares
fleet-wide capacity pools: a 429 with `Retry-After: 1` means capacity is
momentarily busy, and retrying as the header says is the right response.

**Can I refresh the key or check its status?** No. The key is long-lived until
the user revokes it in the dashboard. A 401 or 403 from `api.unbiased.ai`
means it was revoked or the account lost access; prompt the user to run login again.

**Where is my `client_id` used?** Only in these two requests. Do not send it
to `api.unbiased.ai`.

## Checklist before you ship

- [ ] `client_id` comes from your config or build, with a base-URL override
      for testing.
- [ ] The terminal prints the code and the URL even when it opens a browser.
- [ ] The poll loop sleeps `interval` before its first request.
- [ ] `slow_down` adds 5 seconds and keeps polling.
- [ ] Automatic HTTP retries are off for the token endpoint; a transport
      failure ends the flow.
- [ ] Nothing is sent after the 200.
- [ ] The key is stored with owner-only permissions and never logged.
- [ ] Requests to `api.unbiased.ai` use model `pareto` with the key in the
      right header for your dialect.
- [ ] The conformance kit passes 6/6.
