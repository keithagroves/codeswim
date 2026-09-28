// "Sign in with Unbiased": the OAuth 2.0 device authorization grant (RFC 8628)
// against Unbiased's platform, which mints a Pareto API key for the user.
// Wire contract: ../partner-integration-guide.md. Wire discipline is checked
// by ../conformance (npm run conformance).
//
// Shaped like @codeswim/domain-github's device flow, but Unbiased is stricter
// about one thing and the code below is built around it: the platform mints
// the key on the 200 and keeps no copy, so ANY second poll of a device code
// after its 200 revokes that key. Therefore:
//   - every token request is sent exactly once — no retry on any failure;
//     a transport error ends the flow ("run sign-in again"), since it may be
//     the lost 200 and a retry would revoke a key nobody holds;
//   - nothing is sent after the 200;
//   - the loop sleeps `interval` BEFORE its first poll, and slow_down adds 5s
//     permanently.
// Node's fetch (undici) never retries a POST on its own, so plain fetch is
// safe here; don't swap in a client with retry middleware.
//
// Electron-free: the host supplies clientId, device name, and what to do with
// the key. The client_id is public by design (no secret, no redirect URI) —
// it's only ever sent to the platform, never to api.unbiased.ai.

export const UNBIASED_PLATFORM_URL = 'https://platform.unbiased.ai'
export const UNBIASED_API_URL = 'https://api.unbiased.ai'

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

export interface DeviceGrant {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
  interval: number
}

export type DeviceStart = { ok: true; grant: DeviceGrant } | { ok: false; code: string }

export interface DeviceToken {
  accessToken: string
  organizationId: string
  workloadId: string
  workloadName: string
  keyName: string
  // The approving member, a redemption-time snapshot for display. Optional
  // per the guide; `name` may be null.
  user: { id: string; name: string | null } | null
}

// `code` is the platform's RFC 6749 error code, or one of ours:
//   'network'   — transport failure (never retried, see above)
//   'cancelled' — the host aborted the flow between polls
//   'http_<n>'  — a non-JSON / unrecognized response
export type DevicePoll = ({ ok: true } & DeviceToken) | { ok: false; code: string }

interface PostResult {
  status: number
  body: Record<string, unknown> | null
}

async function post(url: string, params: Record<string, string>): Promise<PostResult> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json'
    },
    body: new URLSearchParams(params).toString()
  })
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  return { status: res.status, body }
}

function errorCode(r: PostResult): string {
  return typeof r.body?.error === 'string' ? r.body.error : `http_${r.status}`
}

export async function startDeviceAuthorization(opts: {
  platformUrl?: string
  clientId: string
  deviceName?: string | null
}): Promise<DeviceStart> {
  const params: Record<string, string> = { client_id: opts.clientId }
  if (opts.deviceName) params.device_name = opts.deviceName.slice(0, 100)
  let r: PostResult
  try {
    r = await post(
      `${opts.platformUrl ?? UNBIASED_PLATFORM_URL}/api/oauth/device_authorization`,
      params
    )
  } catch {
    return { ok: false, code: 'network' }
  }
  const b = r.body
  if (r.status !== 200 || !b || typeof b.device_code !== 'string') {
    return { ok: false, code: errorCode(r) }
  }
  return {
    ok: true,
    grant: {
      deviceCode: b.device_code,
      userCode: String(b.user_code),
      verificationUri: String(b.verification_uri),
      verificationUriComplete: String(b.verification_uri_complete ?? b.verification_uri),
      expiresIn: Number(b.expires_in) || 900,
      interval: Number(b.interval) || 5
    }
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function pollDeviceToken(opts: {
  platformUrl?: string
  clientId: string
  grant: DeviceGrant
  // Checked only BETWEEN polls: an in-flight token request is never
  // abandoned, because its answer may be the one-and-only 200.
  signal?: AbortSignal
  // Test seam; defaults to a real timer.
  sleep?: (ms: number) => Promise<void>
}): Promise<DevicePoll> {
  const sleep = opts.sleep ?? defaultSleep
  const url = `${opts.platformUrl ?? UNBIASED_PLATFORM_URL}/api/oauth/token`
  const deadline = Date.now() + opts.grant.expiresIn * 1000
  let interval = Math.max(1, opts.grant.interval)

  for (;;) {
    await sleep(interval * 1000) // sleep FIRST
    if (opts.signal?.aborted) return { ok: false, code: 'cancelled' }
    if (Date.now() > deadline) return { ok: false, code: 'expired_token' }

    let r: PostResult
    try {
      r = await post(url, {
        grant_type: GRANT_TYPE,
        device_code: opts.grant.deviceCode,
        client_id: opts.clientId
      })
    } catch {
      return { ok: false, code: 'network' } // never retry
    }

    const b = r.body
    if (r.status === 200) {
      // A 200 that doesn't carry a key still ends the flow: the key was
      // minted and is lost, so "sign in again" is the only correct answer.
      if (!b || typeof b.access_token !== 'string') return { ok: false, code: 'server_error' }
      const user = b.user as { id?: unknown; name?: unknown } | null | undefined
      return {
        ok: true,
        accessToken: b.access_token,
        organizationId: String(b.organization_id ?? ''),
        workloadId: String(b.workload_id ?? ''),
        workloadName: String(b.workload_name ?? ''),
        keyName: String(b.key_name ?? ''),
        user:
          user && typeof user.id === 'string'
            ? { id: user.id, name: typeof user.name === 'string' ? user.name : null }
            : null
      }
    }

    const code = errorCode(r)
    if (code === 'authorization_pending') continue
    if (code === 'slow_down') {
      interval += 5 // permanent, and a 429 slow_down is treated the same
      continue
    }
    if (code === 'temporarily_unavailable') continue
    return { ok: false, code }
  }
}

// User-facing copy for a failed start or poll, per the guide's suggestions.
export function describeDeviceAuthError(code: string): string {
  switch (code) {
    case 'invalid_client':
      return "This build isn't registered for Unbiased sign-in. Please update Codeswim."
    case 'access_denied':
      return 'Sign-in was declined in the browser.'
    case 'expired_token':
      return 'The sign-in code expired before it was confirmed. Try signing in again.'
    case 'network':
      return 'Lost the connection while waiting for approval. Try signing in again.'
    case 'temporarily_unavailable':
      return 'Unbiased sign-in is temporarily unavailable. Try again in a minute.'
    case 'cancelled':
      return 'Sign-in was cancelled.'
    default:
      return `Unbiased sign-in failed (${code}). Try signing in again.`
  }
}
