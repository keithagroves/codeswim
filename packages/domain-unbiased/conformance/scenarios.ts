/**
 * The conformance scenarios (docs/partner-device-flow.md → Conformance kit).
 * Each drives the adapter against a scripted MockPlatform and asserts from the
 * WIRE — request counts and timing — not from the adapter's return shape
 * alone. Timing tolerances are generous (±500ms) to stay flake-free; the
 * rules under test are second-scale.
 *
 * Deliberately NOT asserted (the doc's over-assertion warning): the race
 * where two polls claim one approved code — the loser's invalid_grant does
 * not revoke. The kit never races polls.
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { ConformanceAdapter } from "./adapter";
import { MockPlatform, SUCCESS_BODY, TokenStep } from "./server";

export type ScenarioResult = { scenario: string; pass: boolean; details: string[] };

const PENDING: TokenStep = { error: "authorization_pending", status: 400 };
const CLIENT_ID = "pc_conformance_client";
/** After a terminal outcome, how long we keep listening for forbidden extra polls. */
const WATCH_MS = 4_000;

type Check = { ok: boolean; label: string };
const check = (ok: boolean, label: string): Check => ({ ok, label });

/** Hard per-scenario deadline: any hang (a client polling past every terminal
 *  signal) becomes a FAIL with a message, never a stuck run (#190). The longest
 *  legitimate scenario finishes in ~25s. */
const SCENARIO_DEADLINE_MS = 60_000;

async function run(
  name: string,
  server: MockPlatform,
  body: (baseUrl: string, checks: Check[]) => Promise<void>
): Promise<ScenarioResult> {
  const checks: Check[] = [];
  const baseUrl = await server.listen();
  try {
    await Promise.race([
      body(baseUrl, checks),
      sleep(SCENARIO_DEADLINE_MS).then(() => {
        throw new Error(`scenario exceeded ${SCENARIO_DEADLINE_MS / 1000}s — a conformant client finishes well inside it`);
      }),
    ]);
  } catch (err) {
    checks.push(check(false, `threw: ${err instanceof Error ? err.message : String(err)}`));
  } finally {
    await server.close();
  }
  return {
    scenario: name,
    pass: checks.every((c) => c.ok),
    details: checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.label}`),
  };
}

export async function runScenarios(adapter: ConformanceAdapter): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];

  // 1. Happy path — and the rule everything hinges on: never re-poll after 200.
  {
    const server = new MockPlatform({ tokenScript: [PENDING, PENDING, "success"], interval: 1 });
    results.push(
      await run("happy path + no re-poll after 200", server, async (baseUrl, checks) => {
        const start = await adapter.start({ baseUrl, clientId: CLIENT_ID, deviceName: "conformance" });
        checks.push(check(start.ok, `start succeeds (got ${start.ok ? "grant" : (start as { code: string }).code})`));
        if (!start.ok) return;
        const authAt = server.requests.find((r) => r.path === "/api/oauth/device_authorization")!.at;
        const result = await adapter.poll({ baseUrl, clientId: CLIENT_ID, grant: start.grant });
        checks.push(check(result.ok, `poll resolves ok (got ${result.ok ? "token" : (result as { code: string }).code})`));
        if (result.ok) {
          checks.push(check(result.accessToken === SUCCESS_BODY.access_token, "access_token delivered verbatim"));
          checks.push(
            check(
              result.organizationId === SUCCESS_BODY.organization_id && result.workloadId === SUCCESS_BODY.workload_id && result.keyName === SUCCESS_BODY.key_name,
              "platform identifiers (org/workload/key) surfaced"
            )
          );
        }
        const polls = server.pollsFor(start.grant.deviceCode);
        checks.push(check(polls.length === 3, `exactly 3 polls to reach the 200 (saw ${polls.length})`));
        checks.push(
          check(
            polls.length > 0 && polls[0].at - authAt >= start.grant.interval * 1000 - 500,
            `sleeps interval FIRST — first poll ${polls.length ? polls[0].at - authAt : "-"}ms after authorization (RFC 8628 textbook slow_down otherwise)`
          )
        );
        await sleep(WATCH_MS);
        const after = server.pollsFor(start.grant.deviceCode);
        checks.push(check(after.length === polls.length, `no poll in the ${WATCH_MS}ms window after the 200 (a re-poll would revoke the key)`));
        checks.push(check(!server.revokedAfter200, "the issued key was never revoked by a re-poll"));
      })
    );
  }

  // 2. slow_down ratchets the interval by +5s (RFC 8628 §3.5).
  {
    const server = new MockPlatform({ tokenScript: [{ error: "slow_down", status: 400 }, PENDING, "success"], interval: 1 });
    results.push(
      await run("slow_down adds 5 seconds", server, async (baseUrl, checks) => {
        const start = await adapter.start({ baseUrl, clientId: CLIENT_ID, deviceName: null });
        checks.push(check(start.ok, "start succeeds"));
        if (!start.ok) return;
        const result = await adapter.poll({ baseUrl, clientId: CLIENT_ID, grant: start.grant });
        checks.push(check(result.ok, "poll eventually succeeds"));
        const polls = server.pollsFor(start.grant.deviceCode);
        const gap = polls.length >= 2 ? polls[1].at - polls[0].at : -1;
        checks.push(check(gap >= (start.grant.interval + 5) * 1000 - 500, `gap after slow_down is interval+5s (saw ${gap}ms, need ≥ ~${(start.grant.interval + 5) * 1000}ms)`));
      })
    );
  }

  // 3. access_denied is terminal.
  {
    const server = new MockPlatform({ tokenScript: [PENDING, { error: "access_denied", status: 400 }], interval: 1 });
    results.push(
      await run("access_denied stops the flow", server, async (baseUrl, checks) => {
        const start = await adapter.start({ baseUrl, clientId: CLIENT_ID, deviceName: null });
        if (!start.ok) return void checks.push(check(false, "start failed"));
        const result = await adapter.poll({ baseUrl, clientId: CLIENT_ID, grant: start.grant });
        checks.push(check(!result.ok && (result as { code: string }).code === "access_denied", `terminal access_denied surfaced (got ${JSON.stringify(result)})`));
        const seen = server.pollsFor(start.grant.deviceCode).length;
        await sleep(WATCH_MS);
        checks.push(check(server.pollsFor(start.grant.deviceCode).length === seen, "no polling past the denial"));
      })
    );
  }

  // 4. The code's lifetime bounds the polling even if the server never resolves.
  {
    const server = new MockPlatform({ tokenScript: [PENDING], expiresIn: 3, interval: 1 });
    results.push(
      await run("expiry bounds the polling", server, async (baseUrl, checks) => {
        const start = await adapter.start({ baseUrl, clientId: CLIENT_ID, deviceName: null });
        if (!start.ok) return void checks.push(check(false, "start failed"));
        const result = await adapter.poll({ baseUrl, clientId: CLIENT_ID, grant: start.grant });
        checks.push(check(!result.ok && (result as { code: string }).code === "expired_token", `expired_token surfaced (got ${JSON.stringify(result)})`));
        const seen = server.pollsFor(start.grant.deviceCode).length;
        await sleep(WATCH_MS);
        checks.push(check(server.pollsFor(start.grant.deviceCode).length === seen, "polling stopped at expiry"));
      })
    );
  }

  // 5. A transport failure mid-poll ends the flow — retrying could be the
  //    lost-200 case, and a retry there revokes the key it can't see.
  {
    const server = new MockPlatform({ tokenScript: ["destroy", PENDING], interval: 1 });
    results.push(
      await run("transport failure is terminal, never retried", server, async (baseUrl, checks) => {
        const start = await adapter.start({ baseUrl, clientId: CLIENT_ID, deviceName: null });
        if (!start.ok) return void checks.push(check(false, "start failed"));
        const result = await adapter.poll({ baseUrl, clientId: CLIENT_ID, grant: start.grant });
        checks.push(check(!result.ok, `flow ends in an error (got ${JSON.stringify(result)})`));
        const seen = server.pollsFor(start.grant.deviceCode).length;
        checks.push(check(seen === 1, `exactly one poll — the destroyed one (saw ${seen})`));
        await sleep(WATCH_MS);
        checks.push(check(server.pollsFor(start.grant.deviceCode).length === 1, "no retry after the transport failure"));
      })
    );
  }

  // 6. invalid_client at start fails cleanly.
  {
    const server = new MockPlatform({ tokenScript: [PENDING], startError: { error: "invalid_client", status: 401 } });
    results.push(
      await run("invalid_client start fails cleanly", server, async (baseUrl, checks) => {
        const start = await adapter.start({ baseUrl, clientId: CLIENT_ID, deviceName: null });
        checks.push(check(!start.ok && (start as { code: string }).code === "invalid_client", `invalid_client surfaced (got ${JSON.stringify(start)})`));
        checks.push(check(server.requests.every((r) => r.path !== "/api/oauth/token"), "no token poll without a grant"));
      })
    );
  }

  return results;
}
