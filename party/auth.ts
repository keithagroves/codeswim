// Pure auth/hashing helpers for the chat room worker, split out of
// codeswim.ts so they can be unit tested without pulling in `partyserver`
// (which imports `cloudflare:workers` and only resolves inside the Workers
// runtime). No Cloudflare-specific APIs here — just Web Crypto and fetch,
// both available in Node too.

import type { AccessDenialReason } from '@codeswim/contract'

const UA = 'codeswim'

export type RoomKind = 'collab' | 'public'

// Hex SHA-256 of `${kind}:${slug}`, first 16 chars — must match
// roomIdentityFromSlug in packages/domain-github/src/room.ts (which uses
// node:crypto for the identical digest).
export async function roomIdForSlug(kind: RoomKind, slug: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${kind}:${slug}`)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
}

export interface GitHubIdentity {
  id: number
  login: string
  name: string | null
  avatarUrl: string | null
}

async function githubFetch(path: string, token: string): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': UA
    }
  })
}

export type AccessResult =
  | { ok: true; identity: GitHubIdentity }
  | { ok: false; reason: AccessDenialReason; status?: number }

// Verifies the token identifies a user AND that user is a listed collaborator
// of the repo named by `slug` (owner, org member with access, or invited
// outside collaborator — not merely "can read a public repo"). Returns the
// verified identity, or a reason for rejection so the client can show
// something more actionable than a flat "denied" — in particular
// 'insufficient-scope' (GitHub 403 on the collaborator check, usually a token
// that predates the `repo` OAuth scope) is a very different fix from
// 'not-collaborator' (GitHub 404, a real "you don't have access"). For
// non-github hosts we can only verify identity (GitHub can't speak to repo
// membership on another forge), which is a weaker but non-anonymous
// guarantee.
export async function verifyAccess(token: string, slug: string): Promise<AccessResult> {
  const userRes = await githubFetch('/user', token)
  if (!userRes.ok) return { ok: false, reason: 'bad-token', status: userRes.status }
  const u = (await userRes.json()) as {
    id: number
    login: string
    name: string | null
    avatar_url: string | null
  }
  const identity: GitHubIdentity = {
    id: u.id,
    login: u.login,
    name: u.name,
    avatarUrl: u.avatar_url
  }

  const parts = slug.split('/')
  if (parts[0] === 'github.com' && parts.length >= 3) {
    const collabRes = await githubFetch(
      `/repos/${encodeURIComponent(parts[1])}/${encodeURIComponent(parts[2])}/collaborators/${encodeURIComponent(u.login)}`,
      token
    )
    if (!collabRes.ok) {
      const reason: AccessDenialReason =
        collabRes.status === 403
          ? 'insufficient-scope'
          : collabRes.status === 404
            ? 'not-collaborator'
            : 'check-failed'
      return { ok: false, reason, status: collabRes.status }
    }
  }
  return { ok: true, identity }
}
