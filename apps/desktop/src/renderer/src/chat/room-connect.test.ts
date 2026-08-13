import { describe, expect, it } from 'vitest'
import { resolveRoomConnect } from './room-connect'
import type { RoomIdentity } from '@codeswim/contract'

const identity: RoomIdentity = {
  roomId: 'collab-room-id',
  publicRoomId: 'public-room-id',
  slug: 'github.com/acme/triage',
  provider: 'github'
}

describe('resolveRoomConnect', () => {
  it('joins the public room with just a display name, no auth required', () => {
    const result = resolveRoomConnect({
      identity,
      configured: true,
      roomKind: 'public',
      user: null,
      token: null,
      name: 'Sam'
    })
    expect(result.effectiveKind).toBe('public')
    expect(result.displayName).toBe('Sam')
    expect(result.auth).toBeNull()
    expect(result.roomId).toBe('public-room-id')
  })

  it('does not connect to the public room without a display name', () => {
    const result = resolveRoomConnect({
      identity,
      configured: true,
      roomKind: 'public',
      user: null,
      token: null,
      name: '   '
    })
    expect(result.roomId).toBeNull()
  })

  it('prefers the GitHub identity name for display when signed in, even in the public room', () => {
    const result = resolveRoomConnect({
      identity,
      configured: true,
      roomKind: 'public',
      user: { name: 'Sam Carter', login: 'samc' },
      token: 'gh-token',
      name: ''
    })
    expect(result.displayName).toBe('Sam Carter')
    expect(result.roomId).toBe('public-room-id')
    // Public rooms never carry auth, even though the user is signed in.
    expect(result.auth).toBeNull()
  })

  it('falls back to the GitHub login when the profile has no display name', () => {
    const result = resolveRoomConnect({
      identity,
      configured: true,
      roomKind: 'public',
      user: { name: null, login: 'samc' },
      token: 'gh-token',
      name: ''
    })
    expect(result.displayName).toBe('samc')
  })

  it('requires a signed-in GitHub user with a token to connect to the collab room', () => {
    const signedOut = resolveRoomConnect({
      identity,
      configured: true,
      roomKind: 'collab',
      user: null,
      token: null,
      name: 'Sam'
    })
    expect(signedOut.roomId).toBeNull()
    expect(signedOut.auth).toBeNull()

    const signedInNoToken = resolveRoomConnect({
      identity,
      configured: true,
      roomKind: 'collab',
      user: { name: 'Sam Carter', login: 'samc' },
      token: null,
      name: ''
    })
    expect(signedInNoToken.roomId).toBeNull()

    const signedIn = resolveRoomConnect({
      identity,
      configured: true,
      roomKind: 'collab',
      user: { name: 'Sam Carter', login: 'samc' },
      token: 'gh-token',
      name: ''
    })
    expect(signedIn.roomId).toBe('collab-room-id')
    expect(signedIn.auth).toEqual({ slug: identity.slug, token: 'gh-token' })
  })

  it('forces public even if collab was selected when GitHub is not configured for this build', () => {
    const result = resolveRoomConnect({
      identity,
      configured: false,
      roomKind: 'collab',
      user: null,
      token: null,
      name: 'Sam'
    })
    expect(result.effectiveKind).toBe('public')
    expect(result.roomId).toBe('public-room-id')
  })

  it('lets an unconfigured build join anonymously with a display name (legacy anonymous mode)', () => {
    const result = resolveRoomConnect({
      identity,
      configured: false,
      roomKind: 'collab',
      user: null,
      token: null,
      name: 'Sam'
    })
    expect(result.auth).toBeNull()
    expect(result.roomId).not.toBeNull()
  })

  it('never connects when there is no room identity (no shared remote)', () => {
    const result = resolveRoomConnect({
      identity: null,
      configured: true,
      roomKind: 'public',
      user: { name: 'Sam Carter', login: 'samc' },
      token: 'gh-token',
      name: ''
    })
    expect(result.roomId).toBeNull()
    expect(result.auth).toBeNull()
  })
})
