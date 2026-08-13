import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { buildSidecarEnv } from './sidecar-env'

const XDG_ROOT = path.join('/tmp', 'userData', 'opencode-xdg')

describe('buildSidecarEnv', () => {
  it('points all four XDG dirs under the isolated root', () => {
    const { env, xdgDirs } = buildSidecarEnv({}, XDG_ROOT, {})
    expect(env.XDG_DATA_HOME).toBe(path.join(XDG_ROOT, 'data'))
    expect(env.XDG_CONFIG_HOME).toBe(path.join(XDG_ROOT, 'config'))
    expect(env.XDG_STATE_HOME).toBe(path.join(XDG_ROOT, 'state'))
    expect(env.XDG_CACHE_HOME).toBe(path.join(XDG_ROOT, 'cache'))
    expect(xdgDirs).toHaveLength(4)
    for (const dir of xdgDirs) expect(dir.startsWith(XDG_ROOT)).toBe(true)
  })

  it('overrides inherited XDG vars so a broken ~/.local cannot leak through', () => {
    const inherited = {
      XDG_DATA_HOME: '/Users/corlin/.local/share',
      XDG_CONFIG_HOME: '/Users/corlin/.config'
    }
    const { env } = buildSidecarEnv(inherited, XDG_ROOT, {})
    expect(env.XDG_DATA_HOME).toBe(path.join(XDG_ROOT, 'data'))
    expect(env.XDG_CONFIG_HOME).toBe(path.join(XDG_ROOT, 'config'))
  })

  it('serializes the config into OPENCODE_CONFIG_CONTENT', () => {
    const config = { plugin: ['file:///plugin.mjs'], permission: 'allow' }
    const { env } = buildSidecarEnv({}, XDG_ROOT, config)
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '')).toEqual(config)
  })

  it('strips OPENCODE_SERVER_PASSWORD but passes other env through', () => {
    const { env } = buildSidecarEnv(
      { OPENCODE_SERVER_PASSWORD: 'hunter2', PATH: '/usr/bin', HOME: '/Users/x' },
      XDG_ROOT,
      {}
    )
    expect(env).not.toHaveProperty('OPENCODE_SERVER_PASSWORD')
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/Users/x')
  })

  it('does not mutate the base env', () => {
    const base = { OPENCODE_SERVER_PASSWORD: 'hunter2' }
    buildSidecarEnv(base, XDG_ROOT, {})
    expect(base.OPENCODE_SERVER_PASSWORD).toBe('hunter2')
  })

  it('adds no CODESWIM_CHAT_* vars when chat is omitted or null', () => {
    const { env } = buildSidecarEnv({}, XDG_ROOT, {}, null)
    expect(Object.keys(env).some((k) => k.startsWith('CODESWIM_CHAT_'))).toBe(false)
  })

  it('threads room identity into CODESWIM_CHAT_* vars', () => {
    const { env } = buildSidecarEnv(
      {},
      XDG_ROOT,
      {},
      {
        partyHost: '127.0.0.1:8788',
        slug: 'github.com/acme/triage',
        publicRoomId: 'pub',
        teamRoomId: 'team',
        token: null
      }
    )
    expect(env.CODESWIM_CHAT_PARTY_HOST).toBe('127.0.0.1:8788')
    expect(env.CODESWIM_CHAT_SLUG).toBe('github.com/acme/triage')
    expect(env.CODESWIM_CHAT_PUBLIC_ROOM_ID).toBe('pub')
    expect(env.CODESWIM_CHAT_TEAM_ROOM_ID).toBe('team')
    expect(env).not.toHaveProperty('CODESWIM_CHAT_TOKEN')
  })

  it('includes the GitHub token only when signed in', () => {
    const { env } = buildSidecarEnv(
      {},
      XDG_ROOT,
      {},
      {
        partyHost: 'h',
        slug: 's',
        publicRoomId: 'p',
        teamRoomId: 't',
        token: 'gh-token'
      }
    )
    expect(env.CODESWIM_CHAT_TOKEN).toBe('gh-token')
  })
})
