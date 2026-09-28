/**
 * What a partner client must expose to be conformance-tested. The shapes
 * mirror the reference client (unbiased-app src/main/device-auth.ts): a
 * partner adapter is a thin mapping from its own client onto these two calls.
 * The kit drives them against a scripted mock platform and asserts the
 * docs/partner-device-flow.md polling discipline from the OUTSIDE — request
 * timing and counts on the wire — so an adapter cannot pass by shape alone.
 */
export type ConformanceGrant = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
};

export type ConformanceStart = { ok: true; grant: ConformanceGrant } | { ok: false; code: string };

export type ConformancePoll =
  | { ok: true; accessToken: string; organizationId: string; workloadId: string; workloadName: string; keyName: string }
  | { ok: false; code: string };

export interface ConformanceAdapter {
  name: string;
  /** POST /api/oauth/device_authorization and normalize the outcome. */
  start(opts: { baseUrl: string; clientId: string; deviceName: string | null }): Promise<ConformanceStart>;
  /** Poll POST /api/oauth/token until a terminal outcome, honouring the RFC 8628 discipline. */
  poll(opts: { baseUrl: string; clientId: string; grant: ConformanceGrant }): Promise<ConformancePoll>;
}
