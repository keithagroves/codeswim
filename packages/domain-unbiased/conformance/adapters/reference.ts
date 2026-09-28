/**
 * Self-test adapters (run.ts --self-test): `compliant` is a minimal correct
 * client proving the kit passes what it should; the two violators carry ONE
 * violation each — a re-poll after the 200, and a skipped first sleep — so
 * the self-test proves each detector individually (review #190). None is a
 * partner deliverable.
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { ConformanceAdapter, ConformanceGrant } from "../adapter";

const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

async function post(url: string, params: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

function makeAdapter(name: string, opts: { sleepFirst: boolean; repollAfter200: boolean }): ConformanceAdapter {
  return {
    name,
    async start(o) {
      let r;
      try {
        r = await post(`${o.baseUrl}/api/oauth/device_authorization`, { client_id: o.clientId, ...(o.deviceName ? { device_name: o.deviceName } : {}) });
      } catch {
        return { ok: false, code: "network" };
      }
      if (r.status !== 200 || !r.body) return { ok: false, code: String(r.body?.error ?? `http_${r.status}`) };
      const b = r.body;
      return {
        ok: true,
        grant: {
          deviceCode: String(b.device_code),
          userCode: String(b.user_code),
          verificationUri: String(b.verification_uri),
          verificationUriComplete: String(b.verification_uri_complete),
          expiresIn: Number(b.expires_in),
          interval: Number(b.interval),
        } as ConformanceGrant,
      };
    },
    async poll(o) {
      let interval = Math.max(1, o.grant.interval);
      let elapsed = 0;
      let first = true;
      for (;;) {
        if (!first || opts.sleepFirst) await sleep(interval * 1000);
        first = false;
        elapsed += interval;
        if (elapsed > o.grant.expiresIn) return { ok: false, code: "expired_token" };
        let r;
        try {
          r = await post(`${o.baseUrl}/api/oauth/token`, { grant_type: GRANT_TYPE, device_code: o.grant.deviceCode, client_id: o.clientId });
        } catch {
          return { ok: false, code: "network" };
        }
        if (r.status === 200 && r.body) {
          if (opts.repollAfter200) {
            // The violation under test: a "transport retry" of the 200.
            await post(`${o.baseUrl}/api/oauth/token`, { grant_type: GRANT_TYPE, device_code: o.grant.deviceCode, client_id: o.clientId }).catch(() => null);
          }
          return {
            ok: true,
            accessToken: String(r.body.access_token),
            organizationId: String(r.body.organization_id),
            workloadId: String(r.body.workload_id),
            workloadName: String(r.body.workload_name),
            keyName: String(r.body.key_name),
          };
        }
        const code = String(r.body?.error ?? `http_${r.status}`);
        if (code === "authorization_pending") continue;
        if (code === "slow_down") { interval += 5; continue; }
        if (code === "temporarily_unavailable") continue;
        return { ok: false, code };
      }
    },
  };
}

export const compliant = makeAdapter("reference-compliant", { sleepFirst: true, repollAfter200: false });
export const violatingRepoll = makeAdapter("reference-violating-repoll", { sleepFirst: true, repollAfter200: true });
export const violatingImpatient = makeAdapter("reference-violating-impatient", { sleepFirst: false, repollAfter200: false });
