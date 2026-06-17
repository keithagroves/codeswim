// GitHub authentication for the chat feature.
//
// We use the OAuth *device flow*: the right fit for a desktop app because it
// needs no client secret and no redirect URI. The flow:
//   1. POST /login/device/code  -> a user_code + verification_uri
//   2. user enters the code at github.com/login/device (we open the browser)
//   3. we poll /login/oauth/access_token until they approve -> access token
//
// This module is Electron-free. The host (apps/desktop) injects the three
// platform touch-points via createGitHubAuth():
//   - clientId:     the GitHub OAuth App client id (from env / build config).
//   - secrets:      encrypted persistence of the raw token (safeStorage + file
//                   in the desktop app; anything that satisfies the interface).
//   - openExternal: opening the verification URL in the user's browser.
// Without a clientId, sign-in is disabled and chat falls back to anonymous.

// read:user for identity; repo so the worker can read private-repo metadata
// when checking access. Public repos need no scope, but we can't know ahead of
// time whether the user's repos are private.
const SCOPES = 'read:user repo'
const UA = 'codeswim'

export interface GitHubUser {
  id: number
  login: string
  name: string | null
  avatarUrl: string | null
}

// Host-provided persistence for the raw OAuth token. The host owns encryption
// and storage location; the package only reads/writes the cleartext token.
export interface GitHubSecretStore {
  read(): Promise<string | null>
  write(token: string): Promise<void>
  clear(): Promise<void>
}

export interface GitHubAuthOptions {
  clientId: string
  secrets: GitHubSecretStore
  openExternal: (url: string) => void
}

export interface GitHubAuth {
  isConfigured(): boolean
  setAuthChangeNotifier(fn: (user: GitHubUser | null) => void): void
  getStatus(): Promise<{ configured: boolean; user: GitHubUser | null }>
  getToken(): Promise<string | null>
  signOut(): Promise<void>
  startDeviceAuth(): Promise<{ userCode: string; verificationUri: string } | { error: string }>
  fetchUser(token: string): Promise<GitHubUser | null>
}

interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function fetchUser(token: string): Promise<GitHubUser | null> {
  const res = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': UA
    }
  })
  if (!res.ok) return null
  const data = (await res.json()) as {
    id: number
    login: string
    name: string | null
    avatar_url: string | null
  }
  return { id: data.id, login: data.login, name: data.name, avatarUrl: data.avatar_url }
}

export function createGitHubAuth(options: GitHubAuthOptions): GitHubAuth {
  const { clientId, secrets, openExternal } = options

  let cachedToken: string | null = null
  let cachedUser: GitHubUser | null = null
  let loaded = false
  // Set by the host so we can push auth changes to the renderer after the
  // (asynchronous) device-flow approval completes.
  let notifier: ((user: GitHubUser | null) => void) | null = null

  function isConfigured(): boolean {
    return clientId.length > 0
  }

  async function ensureLoaded(): Promise<void> {
    if (loaded) return
    cachedToken = await secrets.read()
    if (cachedToken) {
      cachedUser = await fetchUser(cachedToken).catch(() => null)
      // A stored token that no longer resolves a user is stale — drop it.
      if (!cachedUser) {
        cachedToken = null
        await secrets.clear().catch(() => {})
      }
    }
    loaded = true
  }

  async function getStatus(): Promise<{ configured: boolean; user: GitHubUser | null }> {
    await ensureLoaded()
    return { configured: isConfigured(), user: cachedUser }
  }

  async function getToken(): Promise<string | null> {
    await ensureLoaded()
    return cachedToken
  }

  async function signOut(): Promise<void> {
    cachedToken = null
    cachedUser = null
    await secrets.clear().catch(() => {})
    notifier?.(null)
  }

  // Polls for the token in the background until the user approves, times out,
  // or denies. Updates the cache and notifies the host on success.
  async function pollForToken(
    deviceCode: string,
    intervalSec: number,
    expiresIn: number
  ): Promise<void> {
    const deadline = Date.now() + expiresIn * 1000
    let interval = Math.max(intervalSec, 1)
    while (Date.now() < deadline) {
      await sleep(interval * 1000)
      const res = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': UA
        },
        body: JSON.stringify({
          client_id: clientId,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
        })
      })
      const data = (await res.json()) as {
        access_token?: string
        error?: string
        interval?: number
      }
      if (data.access_token) {
        const user = await fetchUser(data.access_token)
        if (!user) return // token came back but is unusable; treat as failure
        cachedToken = data.access_token
        cachedUser = user
        await secrets.write(data.access_token)
        notifier?.(user)
        return
      }
      if (data.error === 'authorization_pending') continue
      if (data.error === 'slow_down') {
        interval = (data.interval ?? interval) + 1
        continue
      }
      // access_denied, expired_token, or anything else → stop.
      return
    }
  }

  // Starts the device flow: returns the code/URL to show the user immediately
  // and opens the verification page; approval is awaited in the background.
  async function startDeviceAuth(): Promise<
    { userCode: string; verificationUri: string } | { error: string }
  > {
    if (!isConfigured()) {
      return { error: 'GitHub sign-in is not configured (set GITHUB_CLIENT_ID).' }
    }
    const res = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ client_id: clientId, scope: SCOPES })
    })
    if (!res.ok) return { error: `GitHub device code request failed (${res.status}).` }
    const data = (await res.json()) as DeviceCodeResponse
    if (!data.device_code) return { error: 'GitHub did not return a device code.' }

    openExternal(data.verification_uri)
    void pollForToken(data.device_code, data.interval, data.expires_in)
    return { userCode: data.user_code, verificationUri: data.verification_uri }
  }

  return {
    isConfigured,
    setAuthChangeNotifier(fn) {
      notifier = fn
    },
    getStatus,
    getToken,
    signOut,
    startDeviceAuth,
    fetchUser
  }
}
