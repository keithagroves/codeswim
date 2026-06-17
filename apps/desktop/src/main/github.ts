// Electron host wiring for the GitHub domain (@codeswim/domain-github).
//
// The package is Electron-free; this module fills in the platform touch-points:
//   - the OAuth client id (electron-vite injects MAIN_VITE_GITHUB_CLIENT_ID),
//   - a SecretStore that encrypts the token with safeStorage and persists it
//     under userData (the same github-auth.json shape we shipped before),
//   - shell.openExternal for the device-flow verification page.
// It then wires the auth instance's getToken into the pull-request client and
// re-exports the wired functions under the names index.ts already uses.

import { app, safeStorage, shell } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import {
  createGitHubAuth,
  createPullRequestClient,
  type GitHubSecretStore
} from '@codeswim/domain-github'

const GITHUB_CLIENT_ID =
  (import.meta.env as unknown as Record<string, string | undefined>).MAIN_VITE_GITHUB_CLIENT_ID ??
  process.env.GITHUB_CLIENT_ID ??
  ''

interface StoredAuth {
  // safeStorage-encrypted token, base64. When encryption is unavailable
  // (rare; some Linux setups) we fall back to plaintext and flag it.
  enc: boolean
  token: string
}

function authFilePath(): string {
  return join(app.getPath('userData'), 'github-auth.json')
}

const secrets: GitHubSecretStore = {
  async read() {
    try {
      const raw = await fs.readFile(authFilePath(), 'utf8')
      const payload = JSON.parse(raw) as StoredAuth
      if (!payload?.token) return null
      if (payload.enc) {
        if (!safeStorage.isEncryptionAvailable()) return null
        return safeStorage.decryptString(Buffer.from(payload.token, 'base64'))
      }
      return payload.token
    } catch {
      return null
    }
  },
  async write(token) {
    const canEncrypt = safeStorage.isEncryptionAvailable()
    const payload: StoredAuth = canEncrypt
      ? { enc: true, token: safeStorage.encryptString(token).toString('base64') }
      : { enc: false, token }
    await fs.writeFile(authFilePath(), JSON.stringify(payload), 'utf8')
  },
  async clear() {
    await fs.rm(authFilePath(), { force: true }).catch(() => {})
  }
}

const auth = createGitHubAuth({
  clientId: GITHUB_CLIENT_ID,
  secrets,
  openExternal: (url) => void shell.openExternal(url)
})

const pulls = createPullRequestClient({ getToken: () => auth.getToken() })

export const getStatus = auth.getStatus
export const getToken = auth.getToken
export const isConfigured = auth.isConfigured
export const setAuthChangeNotifier = auth.setAuthChangeNotifier
export const signOut = auth.signOut
export const startDeviceAuth = auth.startDeviceAuth
export const { listPullRequests, mergePullRequest, pullRequestDiff } = pulls
export type { GitHubUser, MergeMethod } from '@codeswim/domain-github'
