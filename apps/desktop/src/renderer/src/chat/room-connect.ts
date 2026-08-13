// Pure decision logic for which chat room to join and how, extracted out of
// RoomChatPanel so it's unit-testable without rendering React. Two rooms
// exist per repo (see room.ts / party/codeswim.ts):
//   public -> no auth ever, just needs a display name
//   collab -> GitHub-auth-gated when configured; otherwise falls back to
//             anonymous-with-name (same as public, but keyed to the collab
//             room id) so chat still works in unconfigured builds
// Team only means anything when GitHub is configured for this build, so an
// unconfigured build is forced to 'public' regardless of the stored
// preference.

import type { RoomAuth, RoomMode } from './connection'
import type { RoomIdentity } from '@codeswim/contract'

export interface RoomConnectUser {
  name: string | null
  login: string
}

export interface RoomConnectInput {
  identity: RoomIdentity | null
  configured: boolean
  roomKind: RoomMode
  user: RoomConnectUser | null
  token: string | null
  // Manually-chosen display name (used when not signed in). Not required to
  // be pre-trimmed.
  name: string
}

export interface RoomConnectResult {
  effectiveKind: RoomMode
  displayName: string
  auth: RoomAuth | null
  wantConnect: boolean
  roomId: string | null
}

export function resolveRoomConnect(input: RoomConnectInput): RoomConnectResult {
  const { identity, configured, roomKind, user, token, name } = input
  const effectiveKind: RoomMode = configured ? roomKind : 'public'
  const displayName = user ? user.name || user.login : name.trim()

  const auth: RoomAuth | null =
    effectiveKind === 'collab' && user && token && identity ? { slug: identity.slug, token } : null

  const wantConnect = Boolean(
    identity &&
    (effectiveKind === 'public' ? !!displayName : user ? !!token : !configured && !!name.trim())
  )

  const roomId =
    wantConnect && identity
      ? effectiveKind === 'public'
        ? identity.publicRoomId
        : identity.roomId
      : null

  return { effectiveKind, displayName, auth, wantConnect, roomId }
}
