// Chat-room identity for the multi-user collaboration feature.
//
// A room is keyed by the repository's `origin` remote, so two people who
// cloned the same repo land in the same room with no central registry: we
// normalize the remote URL to a canonical `host/owner/repo` slug and hash it
// into a short, opaque room ID. The slug is kept for display/auth (e.g. the
// server can check GitHub access to `owner/repo`); the ID is what the
// websocket server addresses.
//
// The normalization is pure and unit-tested — the only side effect (reading
// the git remote) lives in getRoomIdentity at the bottom.

import { createHash } from 'node:crypto'
import { gitRemoteUrl } from './git'

export interface RoomIdentity {
  // Opaque, stable room key (hex). Safe to use as a websocket room name.
  roomId: string
  // Canonical 'host/owner/repo', lowercased. Display + server-side auth.
  slug: string
  // 'github' when hosted on github.com, else 'git' for other hosts. Lets the
  // renderer decide whether GitHub OAuth / repo-access checks apply.
  provider: 'github' | 'git'
}

// Turn any git remote URL into a canonical `host/path` slug, or null if it
// doesn't look like a remote we can key on. Handles the three shapes git
// hands back:
//   https://github.com/acme/Triage.git
//   git@github.com:acme/Triage.git
//   ssh://git@github.com/acme/triage
// Trailing '.git' and slashes are stripped; host and path are lowercased so
// case and protocol differences between clones still collide.
export function normalizeRemote(rawUrl: string): string | null {
  const url = rawUrl.trim()
  if (!url) return null

  let host: string
  let path: string

  const scpLike = url.match(/^[^@/]+@([^:]+):(.+)$/)
  if (scpLike) {
    // git@github.com:acme/repo.git
    host = scpLike[1]
    path = scpLike[2]
  } else {
    let rest = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') // strip scheme://
    rest = rest.replace(/^[^@/]+@/, '') // strip user@
    const slash = rest.indexOf('/')
    if (slash === -1) return null
    host = rest.slice(0, slash)
    path = rest.slice(slash + 1)
  }

  host = host.replace(/:\d+$/, '').toLowerCase() // drop any :port
  path = path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .toLowerCase()

  if (!host || !path) return null
  return `${host}/${path}`
}

// Derive the full room identity from a canonical slug. 64 bits of SHA-256 is
// plenty to avoid collisions across realistic repo counts while keeping the
// room name short.
export function roomIdentityFromSlug(slug: string): RoomIdentity {
  const roomId = createHash('sha256').update(slug).digest('hex').slice(0, 16)
  const provider = slug.startsWith('github.com/') ? 'github' : 'git'
  return { roomId, slug, provider }
}

// Read the workspace's origin remote and derive its room identity, or null
// when there's no origin to key on (local-only repo) — the renderer treats
// null as "chat unavailable for this workspace".
export async function getRoomIdentity(rootPath: string): Promise<RoomIdentity | null> {
  const remote = await gitRemoteUrl(rootPath)
  if (!remote) return null
  const slug = normalizeRemote(remote)
  if (!slug) return null
  return roomIdentityFromSlug(slug)
}
