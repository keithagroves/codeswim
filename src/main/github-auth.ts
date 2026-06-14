// GitHub authentication for the chat feature, in the main process.
//
// We use the OAuth *device flow*: the right fit for a desktop app because it
// needs no client secret and no redirect URI. The flow:
//   1. POST /login/device/code  -> a user_code + verification_uri
//   2. user enters the code at github.com/login/device (we open the browser)
//   3. we poll /login/oauth/access_token until they approve -> access token
// The token is stored encrypted (Electron safeStorage) under userData and used
// to (a) show who you are and (b) prove repo access to the chat worker.
//
// Configuration: the client id of a GitHub OAuth App with "Device Flow"
// enabled (not a secret, so it can live in .env / be shipped with the app).
// Set it as MAIN_VITE_GITHUB_CLIENT_ID in .env (electron-vite injects it into
// the main process) or GITHUB_CLIENT_ID in the shell env. Without it, sign-in
// is disabled and chat falls back to anonymous (only usable against a worker
// that doesn't require auth).

import { app, safeStorage, shell } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'

const GITHUB_CLIENT_ID =
  (import.meta.env as unknown as Record<string, string | undefined>).MAIN_VITE_GITHUB_CLIENT_ID ??
  process.env.GITHUB_CLIENT_ID ??
  ''
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

interface StoredAuth {
  // safeStorage-encrypted token, base64. When encryption is unavailable
  // (rare; some Linux setups) we fall back to plaintext and flag it.
  enc: boolean
  token: string
}

let cachedToken: string | null = null
let cachedUser: GitHubUser | null = null
let loaded = false
// Set by index.ts so we can push auth changes to the renderer after the
// (asynchronous) device-flow approval completes.
let notifier: ((user: GitHubUser | null) => void) | null = null

export function isConfigured(): boolean {
  return GITHUB_CLIENT_ID.length > 0
}

export function setAuthChangeNotifier(fn: (user: GitHubUser | null) => void): void {
  notifier = fn
}

function authFilePath(): string {
  return join(app.getPath('userData'), 'github-auth.json')
}

async function persistToken(token: string): Promise<void> {
  const canEncrypt = safeStorage.isEncryptionAvailable()
  const payload: StoredAuth = canEncrypt
    ? { enc: true, token: safeStorage.encryptString(token).toString('base64') }
    : { enc: false, token }
  await fs.writeFile(authFilePath(), JSON.stringify(payload), 'utf8')
}

async function loadToken(): Promise<string | null> {
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
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return
  cachedToken = await loadToken()
  if (cachedToken) {
    cachedUser = await fetchUser(cachedToken).catch(() => null)
    // A stored token that no longer resolves a user is stale — drop it.
    if (!cachedUser) {
      cachedToken = null
      await fs.rm(authFilePath(), { force: true }).catch(() => {})
    }
  }
  loaded = true
}

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

export async function getStatus(): Promise<{ configured: boolean; user: GitHubUser | null }> {
  await ensureLoaded()
  return { configured: isConfigured(), user: cachedUser }
}

export async function getToken(): Promise<string | null> {
  await ensureLoaded()
  return cachedToken
}

export async function signOut(): Promise<void> {
  cachedToken = null
  cachedUser = null
  await fs.rm(authFilePath(), { force: true }).catch(() => {})
  notifier?.(null)
}

interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Polls for the token in the background until the user approves, times out, or
// denies. Updates the cache and notifies the renderer on success.
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
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
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
      await persistToken(data.access_token)
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

// Starts the device flow: returns the code/URL to show the user immediately and
// opens the verification page; approval is awaited in the background.
export async function startDeviceAuth(): Promise<
  { userCode: string; verificationUri: string } | { error: string }
> {
  if (!isConfigured()) return { error: 'GitHub sign-in is not configured (set GITHUB_CLIENT_ID).' }
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: SCOPES })
  })
  if (!res.ok) return { error: `GitHub device code request failed (${res.status}).` }
  const data = (await res.json()) as DeviceCodeResponse
  if (!data.device_code) return { error: 'GitHub did not return a device code.' }

  void shell.openExternal(data.verification_uri)
  void pollForToken(data.device_code, data.interval, data.expires_in)
  return { userCode: data.user_code, verificationUri: data.verification_uri }
}
