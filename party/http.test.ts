import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleRoomHttpRequest, type RoomRequestContext } from './http'
import { roomIdForSlug } from './auth'
import type { ChatMessage } from '@codeswim/contract'

const SLUG = 'github.com/acme/triage'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

async function baseCtx(overrides: Partial<RoomRequestContext> = {}): Promise<RoomRequestContext> {
  return {
    roomName: await roomIdForSlug('public', SLUG),
    requireAuth: true,
    messages: [],
    randomId: () => 'fixed-id',
    now: () => 1700000000000,
    ...overrides
  }
}

describe('handleRoomHttpRequest', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects a request whose claimed slug does not hash to this room', async () => {
    const ctx = await baseCtx({ roomName: 'not-the-right-hash' })
    const req = new Request(`https://x/?mode=public&slug=${encodeURIComponent(SLUG)}`)
    const outcome = await handleRoomHttpRequest(req, ctx)
    expect(outcome.status).toBe(400)
    expect(outcome.body).toEqual({ error: 'room-mismatch' })
  })

  it('lists recent messages on GET to the public room with no auth needed', async () => {
    const history: ChatMessage[] = [{ id: '1', userId: 'u1', name: 'Sam', text: 'hi', sentAt: 1 }]
    const ctx = await baseCtx({ messages: history })
    const req = new Request(`https://x/?mode=public&slug=${encodeURIComponent(SLUG)}`)
    const outcome = await handleRoomHttpRequest(req, ctx)
    expect(outcome.status).toBe(200)
    expect(outcome.body).toEqual({ slug: SLUG, mode: 'public', messages: history })
  })

  it('posts a message to the public room using the ?name= query param', async () => {
    const ctx = await baseCtx()
    const req = new Request(
      `https://x/?mode=public&slug=${encodeURIComponent(SLUG)}&name=${encodeURIComponent('The Agent')}`,
      { method: 'POST', body: JSON.stringify({ text: 'building the thing now' }) }
    )
    const outcome = await handleRoomHttpRequest(req, ctx)
    expect(outcome.status).toBe(201)
    expect(outcome.appended).toEqual({
      id: 'fixed-id',
      userId: 'http:fixed-id',
      name: 'The Agent',
      text: 'building the thing now',
      sentAt: 1700000000000
    })
  })

  it('rejects an empty or whitespace-only POST body', async () => {
    const ctx = await baseCtx()
    const req = new Request(`https://x/?mode=public&slug=${encodeURIComponent(SLUG)}`, {
      method: 'POST',
      body: JSON.stringify({ text: '   ' })
    })
    const outcome = await handleRoomHttpRequest(req, ctx)
    expect(outcome.status).toBe(400)
    expect(outcome.appended).toBeUndefined()
  })

  it('requires a valid collaborator token to read or post the collab room when auth is enforced', async () => {
    const collabRoomName = await roomIdForSlug('collab', SLUG)
    const ctx = await baseCtx({ roomName: collabRoomName, requireAuth: true })
    const req = new Request(`https://x/?mode=collab&slug=${encodeURIComponent(SLUG)}`)
    const outcome = await handleRoomHttpRequest(req, ctx)
    expect(outcome.status).toBe(403)
    expect(outcome.body).toEqual({ error: 'auth-failed', reason: 'bad-token' })
  })

  it('admits a verified collaborator into the collab room and uses their GitHub identity', async () => {
    const collabRoomName = await roomIdForSlug('collab', SLUG)
    const ctx = await baseCtx({ roomName: collabRoomName, requireAuth: true })

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/user')) {
        return jsonResponse({ id: 42, login: 'samc', name: 'Sam Carter', avatar_url: null })
      }
      if (url.includes('/collaborators/samc')) {
        return new Response(null, { status: 204 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const req = new Request(`https://x/?mode=collab&slug=${encodeURIComponent(SLUG)}`, {
      method: 'POST',
      headers: { authorization: 'Bearer good-token' },
      body: JSON.stringify({ text: 'shipped it' })
    })
    const outcome = await handleRoomHttpRequest(req, ctx)
    expect(outcome.status).toBe(201)
    expect(outcome.appended).toMatchObject({
      userId: 'gh:42',
      name: 'Sam Carter',
      text: 'shipped it'
    })
  })

  it('skips the auth check for the collab room when the worker has auth disabled (local dev)', async () => {
    const collabRoomName = await roomIdForSlug('collab', SLUG)
    const ctx = await baseCtx({ roomName: collabRoomName, requireAuth: false })
    const req = new Request(`https://x/?mode=collab&slug=${encodeURIComponent(SLUG)}&name=Dev`)
    const outcome = await handleRoomHttpRequest(req, ctx)
    expect(outcome.status).toBe(200)
  })

  it('returns 405 for unsupported methods', async () => {
    const ctx = await baseCtx()
    const req = new Request(`https://x/?mode=public&slug=${encodeURIComponent(SLUG)}`, {
      method: 'DELETE'
    })
    const outcome = await handleRoomHttpRequest(req, ctx)
    expect(outcome.status).toBe(405)
  })
})
