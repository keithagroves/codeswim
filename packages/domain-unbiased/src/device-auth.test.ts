// Edge cases the partner conformance kit (npm run conformance) doesn't cover.
// The kit owns the wire-timing rules; these pin the parsing and the
// cancel/malformed-200 paths, with a fake fetch and an instant sleep.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  describeDeviceAuthError,
  pollDeviceToken,
  startDeviceAuthorization,
  type DeviceGrant
} from './device-auth'

const grant: DeviceGrant = {
  deviceCode: 'dc',
  userCode: 'BCDF-GHJK',
  verificationUri: 'https://platform.test/activate',
  verificationUriComplete: 'https://platform.test/activate?user_code=BCDF-GHJK',
  expiresIn: 900,
  interval: 5
}

function respond(...bodies: Array<[number, unknown]>): ReturnType<typeof vi.fn> {
  const fn = vi.fn()
  for (const [status, body] of bodies) {
    fn.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }))
  }
  vi.stubGlobal('fetch', fn)
  return fn
}

const instant = (): Promise<void> => Promise.resolve()

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('startDeviceAuthorization', () => {
  it('normalizes the grant and truncates the device name to 100 chars', async () => {
    const fetch = respond([
      200,
      {
        device_code: 'dc',
        user_code: 'BCDF-GHJK',
        verification_uri: 'https://platform.test/activate',
        verification_uri_complete: 'https://platform.test/activate?user_code=BCDF-GHJK',
        expires_in: 900,
        interval: 5
      }
    ])
    const r = await startDeviceAuthorization({ clientId: 'cid', deviceName: 'h'.repeat(150) })
    expect(r).toEqual({ ok: true, grant })
    const sent = new URLSearchParams(fetch.mock.calls[0][1].body as string)
    expect(sent.get('client_id')).toBe('cid')
    expect(sent.get('device_name')).toHaveLength(100)
  })

  it('surfaces the platform error code', async () => {
    respond([401, { error: 'invalid_client', error_description: 'unknown' }])
    expect(await startDeviceAuthorization({ clientId: 'x' })).toEqual({
      ok: false,
      code: 'invalid_client'
    })
  })
})

describe('pollDeviceToken', () => {
  it('returns the key and optional approver, then stops', async () => {
    const fetch = respond(
      [400, { error: 'authorization_pending' }],
      [
        200,
        {
          access_token: 'sk_pareto_1',
          organization_id: 'org',
          workload_id: 'wl',
          workload_name: 'codeswim-mac',
          key_name: 'Alex · Codeswim · 2026-09-26',
          user: { id: 'm1', name: 'Alex' }
        }
      ]
    )
    const r = await pollDeviceToken({ clientId: 'cid', grant, sleep: instant })
    expect(r).toMatchObject({
      ok: true,
      accessToken: 'sk_pareto_1',
      workloadName: 'codeswim-mac',
      user: { id: 'm1', name: 'Alex' }
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('treats a 200 without a key as terminal — never re-polls', async () => {
    const fetch = respond([200, { token_type: 'bearer' }])
    const r = await pollDeviceToken({ clientId: 'cid', grant, sleep: instant })
    expect(r).toEqual({ ok: false, code: 'server_error' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('checks cancellation between polls without sending another', async () => {
    const abort = new AbortController()
    const fetch = respond([400, { error: 'authorization_pending' }])
    const sleep = vi.fn(async () => {
      if (fetch.mock.calls.length === 1) abort.abort()
    })
    const r = await pollDeviceToken({ clientId: 'cid', grant, signal: abort.signal, sleep })
    expect(r).toEqual({ ok: false, code: 'cancelled' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('never sends the client_id anywhere but the platform token endpoint', async () => {
    const fetch = respond([400, { error: 'access_denied' }])
    await pollDeviceToken({ platformUrl: 'https://p.test', clientId: 'cid', grant, sleep: instant })
    expect(fetch.mock.calls[0][0]).toBe('https://p.test/api/oauth/token')
  })
})

describe('describeDeviceAuthError', () => {
  it('uses the guide copy for invalid_client', () => {
    expect(describeDeviceAuthError('invalid_client')).toMatch(/update Codeswim/)
  })
})
