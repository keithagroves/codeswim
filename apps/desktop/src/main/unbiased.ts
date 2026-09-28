// Electron host wiring for "Sign in with Unbiased" (@codeswim/domain-unbiased).
//
// The package runs the device flow; this module fills in the platform bits:
//   - the partner client_id (public by design — see the package header) and a
//     platform base-URL override for testing against a mock,
//   - shell.openExternal for the verification page,
//   - where the minted key goes: the host injects applyKey/removeKey, which
//     write opencode's auth store for the `pareto` provider (sidecar.ts), the
//     same store a pasted key lands in. The key never crosses IPC, is never
//     logged, and isn't kept here after it's handed off.
// Alongside it we persist only display labels (workload, key name, approver)
// so the UI can say what you're signed in to.

import { app, shell } from 'electron'
import { hostname } from 'os'
import { join } from 'path'
import { promises as fs } from 'fs'
import {
  UNBIASED_PLATFORM_URL,
  describeDeviceAuthError,
  pollDeviceToken,
  startDeviceAuthorization
} from '@codeswim/domain-unbiased'
import type {
  UnbiasedAccount,
  UnbiasedAuthEvent,
  UnbiasedSignInPending,
  UnbiasedStatus
} from '@codeswim/contract'

const env = import.meta.env as unknown as Record<string, string | undefined>

const CLIENT_ID =
  env.MAIN_VITE_UNBIASED_CLIENT_ID ?? process.env.UNBIASED_CLIENT_ID ?? 'gjq5kLk99bhGsxiPVtTUiA'
const PLATFORM_URL = process.env.UNBIASED_PLATFORM_URL ?? UNBIASED_PLATFORM_URL

// The opencode provider id the key is stored under (see sidecar.ts config).
export const UNBIASED_PROVIDER_ID = 'pareto'

export interface UnbiasedHost {
  applyKey(rootPath: string, key: string): Promise<void>
  removeKey(rootPath: string): Promise<void>
  notify(event: UnbiasedAuthEvent): void
}

function accountFilePath(): string {
  return join(app.getPath('userData'), 'unbiased-account.json')
}

async function readAccount(): Promise<UnbiasedAccount | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(accountFilePath(), 'utf8')) as UnbiasedAccount
    return parsed?.workloadName !== undefined ? parsed : null
  } catch {
    return null
  }
}

let pending: { info: UnbiasedSignInPending; abort: AbortController } | null = null

export async function getStatus(): Promise<UnbiasedStatus> {
  return { account: await readAccount(), pending: pending?.info ?? null }
}

export function cancelSignIn(): void {
  pending?.abort.abort()
  pending = null
}

// Starts the device flow and returns the code to display at once; approval
// is awaited in the background and reported through host.notify.
export async function startSignIn(
  rootPath: string,
  host: UnbiasedHost
): Promise<UnbiasedSignInPending | { error: string }> {
  // A new sign-in supersedes one still waiting (its code is simply left to
  // expire; the aborted loop sends nothing further).
  cancelSignIn()

  const start = await startDeviceAuthorization({
    platformUrl: PLATFORM_URL,
    clientId: CLIENT_ID,
    deviceName: hostname()
  })
  if (!start.ok) return { error: describeDeviceAuthError(start.code) }

  const { grant } = start
  const info: UnbiasedSignInPending = {
    userCode: grant.userCode,
    verificationUri: grant.verificationUri,
    verificationUriComplete: grant.verificationUriComplete,
    expiresAt: Date.now() + grant.expiresIn * 1000
  }
  const abort = new AbortController()
  const mine = { info, abort }
  pending = mine
  void shell.openExternal(grant.verificationUriComplete)

  void (async () => {
    const result = await pollDeviceToken({
      platformUrl: PLATFORM_URL,
      clientId: CLIENT_ID,
      grant,
      signal: abort.signal
    })
    if (pending === mine) pending = null
    if (!result.ok) {
      if (result.code !== 'cancelled') {
        host.notify({ status: 'error', message: describeDeviceAuthError(result.code) })
      }
      return
    }
    try {
      await host.applyKey(rootPath, result.accessToken)
    } catch (err) {
      // The key was minted but we couldn't store it. It's unrecoverable from
      // here (never re-poll), so the only way forward is a fresh sign-in; the
      // orphaned key shows in the Unbiased dashboard and can be revoked there.
      const reason = err instanceof Error ? err.message : String(err)
      host.notify({
        status: 'error',
        message: `Signed in, but Codeswim couldn't save the key (${reason}). Try signing in again.`
      })
      return
    }
    const account: UnbiasedAccount = {
      workloadName: result.workloadName,
      keyName: result.keyName,
      userName: result.user?.name ?? null,
      signedInAt: new Date().toISOString()
    }
    await fs
      .writeFile(accountFilePath(), JSON.stringify(account), { encoding: 'utf8', mode: 0o600 })
      .catch(() => {})
    host.notify({ status: 'signed-in', account })
  })()

  return info
}

export async function signOut(rootPath: string, host: UnbiasedHost): Promise<void> {
  cancelSignIn()
  await host.removeKey(rootPath)
  await fs.rm(accountFilePath(), { force: true }).catch(() => {})
  host.notify({ status: 'signed-out' })
}
