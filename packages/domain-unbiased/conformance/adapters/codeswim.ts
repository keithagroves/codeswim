/**
 * Codeswim's conformance adapter: a straight mapping from the kit's two calls
 * onto @codeswim/domain-unbiased, the same client the desktop app ships.
 *
 *   npm run conformance --workspace @codeswim/domain-unbiased
 */
import type { ConformanceAdapter } from '../adapter'
import { pollDeviceToken, startDeviceAuthorization } from '../../src/device-auth'

const adapter: ConformanceAdapter = {
  name: 'codeswim',
  start: ({ baseUrl, clientId, deviceName }) =>
    startDeviceAuthorization({ platformUrl: baseUrl, clientId, deviceName }),
  async poll({ baseUrl, clientId, grant }) {
    const r = await pollDeviceToken({ platformUrl: baseUrl, clientId, grant })
    if (!r.ok) return r
    return {
      ok: true,
      accessToken: r.accessToken,
      organizationId: r.organizationId,
      workloadId: r.workloadId,
      workloadName: r.workloadName,
      keyName: r.keyName
    }
  }
}

export default adapter
