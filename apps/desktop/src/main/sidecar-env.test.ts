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
})
