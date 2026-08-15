import { afterEach, describe, expect, it, vi } from 'vitest'
import { roomIdForSlug, verifyAccess } from './auth'
import { roomIdentityFromSlug } from '../packages/domain-github/src/room'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('roomIdForSlug', () => {
  it('agrees with the client-side hash in roomIdentityFromSlug', async () => {
    const slug = 'github.com/acme/triage'
    const identity = roomIdentityFromSlug(slug)
    expect(await roomIdForSlug('collab', slug)).toBe(identity.roomId)
    expect(await roomIdForSlug('public', slug)).toBe(identity.publicRoomId)
  })

  it('gives the collab and public rooms different ids for the same slug', async () => {
    const slug = 'github.com/acme/triage'
    expect(await roomIdForSlug('collab', slug)).not.toBe(await roomIdForSlug('public', slug))
  })

  it('a public-mode claim never hashes to the real collab room, even for the true slug', async () => {
    const slug = 'github.com/acme/triage'
    const collabRoomId = await roomIdForSlug('collab', slug)
    const claimedAsPublic = await roomIdForSlug('public', slug)
    expect(claimedAsPublic).not.toBe(collabRoomId)
  })
})

describe('verifyAccess', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects when the token does not identify a user', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ message: 'Bad credentials' }, 401))
    )
    const result = await verifyAccess('bad-token', 'github.com/acme/triage')
    expect(result).toEqual({ ok: false, reason: 'bad-token', status: 401 })
  })

  it('admits a listed collaborator of a github.com repo', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/user')) {
        return jsonResponse({ id: 42, login: 'samc', name: 'Sam Carter', avatar_url: 'a.png' })
      }
      if (url.includes('/repos/acme/triage/collaborators/samc')) {
        return new Response(null, { status: 204 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await verifyAccess('good-token', 'github.com/acme/triage')
    expect(result).toEqual({
      ok: true,
      identity: { id: 42, login: 'samc', name: 'Sam Carter', avatarUrl: 'a.png' }
    })
    // Confirms we check collaborator status, not just repo-read access.
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/repos/acme/triage/collaborators/samc'),
      expect.anything()
    )
  })

  it('rejects a valid GitHub user who is not a collaborator on the repo', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/user')) {
        return jsonResponse({ id: 7, login: 'outsider', name: null, avatar_url: null })
      }
      if (url.includes('/collaborators/outsider')) {
        // Not a collaborator — 404, even though the repo may be public and
        // readable by anyone. This is the case that used to slip through
        // when the check was a plain repo-read probe.
        return jsonResponse({ message: 'Not Found' }, 404)
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await verifyAccess('outsider-token', 'github.com/acme/triage')
    expect(result).toEqual({ ok: false, reason: 'not-collaborator', status: 404 })
  })

  it('distinguishes a scope-starved token (403) from a genuine non-collaborator (404)', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/user')) {
        return jsonResponse({ id: 9, login: 'oldtoken', name: null, avatar_url: null })
      }
      if (url.includes('/collaborators/oldtoken')) {
        // The identity check itself was refused — a token that predates the
        // `repo` OAuth scope looks exactly like this, even for the repo's
        // own owner.
        return jsonResponse({ message: 'Forbidden' }, 403)
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await verifyAccess('scope-starved-token', 'github.com/acme/triage')
    expect(result).toEqual({ ok: false, reason: 'insufficient-scope', status: 403 })
  })

  it('skips the collaborator check for non-github hosts (identity-only guarantee)', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/user')) {
        return jsonResponse({ id: 1, login: 'samc', name: 'Sam Carter', avatar_url: null })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await verifyAccess('token', 'gitlab.com/group/project')
    expect(result).toEqual({
      ok: true,
      identity: { id: 1, login: 'samc', name: 'Sam Carter', avatarUrl: null }
    })
    expect(fetchMock).toHaveBeenCalledTimes(1) // only /user, no collaborator probe
  })
})
