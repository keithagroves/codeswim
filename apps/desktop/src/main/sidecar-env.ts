// Pure construction of the opencode sidecar's environment, split from
// sidecar.ts so it can be unit-tested without Electron.

import path from 'node:path'

export interface SidecarEnvResult {
  env: NodeJS.ProcessEnv
  // Directories the caller must create before spawning.
  xdgDirs: string[]
}

// Chat room identity + credential threaded into the sidecar so the harness's
// chat_read/chat_send tools (packages/harness/src/tool/chat.ts) know which
// room to talk to. Resolved by the caller from getRoomIdentity(rootPath) and
// the stored GitHub token — see apps/desktop/src/main/index.ts's
// `harness:start` handler. null when the workspace has no shared git remote
// to key a room on (chat tools won't be registered at all in that case).
export interface SidecarChatConfig {
  partyHost: string
  slug: string
  publicRoomId: string
  teamRoomId: string
  // null when not signed in with GitHub — the 'team' room just won't be
  // usable; 'public' still works.
  token: string | null
}

// Build the spawn env for `opencode serve`.
//
// - Isolates opencode's on-disk state under `xdgRoot` (in practice Electron's
//   userData dir). The XDG defaults (~/.local/share etc.) fail hard when
//   ~/.local is root-owned — a common leftover from past sudo installs — and
//   isolation also keeps the app's opencode state (auth, sessions) separate
//   from any opencode CLI the user has installed.
// - Passes the config via OPENCODE_CONFIG_CONTENT so we never write into the
//   user's workspace or global opencode config.
// - Strips OPENCODE_SERVER_PASSWORD: the server binds to loopback only and
//   the SDK talks to it without auth headers.
// - When `chat` is given, adds the CODESWIM_CHAT_* vars the harness's chat
//   tools read (see resolveChatConfig in packages/harness/src/tool/chat.ts).
//   Omitting the token var entirely (rather than an empty string) when not
//   signed in keeps `resolveChatConfig` treating it the same as "unset".
export function buildSidecarEnv(
  baseEnv: NodeJS.ProcessEnv,
  xdgRoot: string,
  config: unknown,
  chat?: SidecarChatConfig | null
): SidecarEnvResult {
  const xdg = {
    XDG_DATA_HOME: path.join(xdgRoot, 'data'),
    XDG_CONFIG_HOME: path.join(xdgRoot, 'config'),
    XDG_STATE_HOME: path.join(xdgRoot, 'state'),
    XDG_CACHE_HOME: path.join(xdgRoot, 'cache')
  }
  const chatEnv: NodeJS.ProcessEnv = chat
    ? {
        CODESWIM_CHAT_PARTY_HOST: chat.partyHost,
        CODESWIM_CHAT_SLUG: chat.slug,
        CODESWIM_CHAT_PUBLIC_ROOM_ID: chat.publicRoomId,
        CODESWIM_CHAT_TEAM_ROOM_ID: chat.teamRoomId,
        ...(chat.token ? { CODESWIM_CHAT_TOKEN: chat.token } : {})
      }
    : {}
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...xdg,
    ...chatEnv,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config)
  }
  delete env.OPENCODE_SERVER_PASSWORD
  return { env, xdgDirs: Object.values(xdg) }
}
