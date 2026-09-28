/**
 * A scripted mock of the platform's two OAuth endpoints, faithful to the wire
 * contract in docs/partner-device-flow.md and the real routes
 * (src/app/api/oauth/{device_authorization,token}/route.ts): form-encoded or
 * JSON bodies, RFC 6749 §5.2 error bodies, `authorization_pending` /
 * `slow_down` 400s, exactly one 200 per code — and the revocation rule: any
 * poll of a redeemed code answers `invalid_grant` and flips `revokedAfter200`,
 * which no scenario forgives.
 */
import http from "node:http";
import { AddressInfo } from "node:net";

export type TokenStep =
  | { error: string; status: number }
  | "success"
  | "destroy"; // kill the socket mid-response: a transport failure the client must not retry

export type RecordedRequest = { at: number; path: string; params: Record<string, string> };

export const SUCCESS_BODY = {
  access_token: "sk_pareto_conformance_1",
  token_type: "bearer",
  organization_id: "org-conf-1",
  workload_id: "wl-conf-1",
  workload_name: "conformance workload",
  key_name: "conformance-key",
  user: { id: "member-conf-1", name: null },
};

export class MockPlatform {
  requests: RecordedRequest[] = [];
  revokedAfter200 = false;
  private tokenPolls = 0;
  private redeemed = false;
  private server: http.Server;
  private startedAt = Date.now();
  private grantIssuedAt: number | null = null;

  constructor(
    private opts: {
      /** Consumed one per poll; the LAST entry repeats forever. */
      tokenScript: TokenStep[];
      expiresIn?: number;
      interval?: number;
      /** Respond to device_authorization with this error instead of a grant. */
      startError?: { error: string; status: number };
    }
  ) {
    this.server = http.createServer((req, res) => void this.handle(req, res));
  }

  async listen(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  pollsFor(deviceCode: string): RecordedRequest[] {
    return this.requests.filter((r) => r.path === "/api/oauth/token" && r.params.device_code === deviceCode);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const params: Record<string, string> = {};
    if ((req.headers["content-type"] ?? "").includes("json")) {
      // Own-entries copy, never Object.assign from parsed JSON (Semgrep's
      // insecure-object-assign: a __proto__ key must not pollute params).
      try {
        for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) params[k] = String(v);
      } catch { /* recorded as empty */ }
    } else {
      for (const [k, v] of new URLSearchParams(raw)) params[k] = v;
    }
    this.requests.push({ at: Date.now() - this.startedAt, path: req.url ?? "", params });

    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };

    if (req.url === "/api/oauth/device_authorization") {
      if (this.opts.startError) return json(this.opts.startError.status, { error: this.opts.startError.error, error_description: "scripted" });
      if (!params.client_id) return json(400, { error: "invalid_request", error_description: "client_id is required" });
      this.grantIssuedAt = Date.now();
      return json(200, {
        device_code: "dc-conformance-1",
        user_code: "BCDF-GHJK",
        verification_uri: "http://127.0.0.1/activate",
        verification_uri_complete: "http://127.0.0.1/activate?user_code=BCDF-GHJK",
        expires_in: this.opts.expiresIn ?? 900,
        interval: this.opts.interval ?? 1,
      });
    }

    if (req.url === "/api/oauth/token") {
      if (params.grant_type !== "urn:ietf:params:oauth:grant-type:device_code") {
        return json(400, { error: "unsupported_grant_type", error_description: "wrong grant_type" });
      }
      if (this.redeemed) {
        // The rule under test: the server cannot tell a lost response from a
        // retry, so a poll after the 200 revokes the issued key.
        this.revokedAfter200 = true;
        return json(400, { error: "invalid_grant", error_description: "device_code already redeemed; the issued key has been revoked" });
      }
      // Faithful to the platform: the SERVER expires the code once its lifetime
      // passes, so a client that learns expiry from the wire (legitimate in
      // production) is served expired_token instead of polling forever (#190).
      const expiresInMs = (this.opts.expiresIn ?? 900) * 1000;
      if (this.grantIssuedAt !== null && Date.now() - this.grantIssuedAt > expiresInMs) {
        return json(400, { error: "expired_token", error_description: "the device_code expired before it was redeemed; restart login" });
      }
      const step = this.opts.tokenScript[Math.min(this.tokenPolls, this.opts.tokenScript.length - 1)];
      this.tokenPolls++;
      if (step === "destroy") return void res.destroy();
      if (step === "success") {
        this.redeemed = true;
        return json(200, SUCCESS_BODY);
      }
      return json(step.status, { error: step.error, error_description: "scripted" });
    }

    return json(404, { error: "invalid_request", error_description: "unknown path" });
  }
}
