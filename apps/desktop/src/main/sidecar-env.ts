// Pure construction of the opencode sidecar's environment, split from
// sidecar.ts so it can be unit-tested without Electron.

import path from 'node:path'

export interface SidecarEnvResult {
  env: NodeJS.ProcessEnv
  // Directories the caller must create before spawning.
  xdgDirs: string[]
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
export function buildSidecarEnv(
  baseEnv: NodeJS.ProcessEnv,
  xdgRoot: string,
  config: unknown
): SidecarEnvResult {
  const xdg = {
    XDG_DATA_HOME: path.join(xdgRoot, 'data'),
    XDG_CONFIG_HOME: path.join(xdgRoot, 'config'),
    XDG_STATE_HOME: path.join(xdgRoot, 'state'),
    XDG_CACHE_HOME: path.join(xdgRoot, 'cache')
  }
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...xdg,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config)
  }
  delete env.OPENCODE_SERVER_PASSWORD
  return { env, xdgDirs: Object.values(xdg) }
}
