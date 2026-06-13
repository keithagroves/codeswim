import { describe, expect, it } from 'vitest'
import { normalizeRemote, roomIdentityFromSlug } from './room'

describe('normalizeRemote', () => {
  it('normalizes https, scp-like, and ssh forms of the same repo to one slug', () => {
    const slugs = [
      'https://github.com/acme/Triage.git',
      'https://github.com/acme/triage',
      'git@github.com:acme/Triage.git',
      'ssh://git@github.com/acme/triage.git',
      'https://github.com/acme/triage/'
    ].map(normalizeRemote)
    for (const slug of slugs) expect(slug).toBe('github.com/acme/triage')
  })

  it('strips credentials and ports', () => {
    expect(normalizeRemote('https://user:token@github.com/acme/triage.git')).toBe(
      'github.com/acme/triage'
    )
    expect(normalizeRemote('ssh://git@ssh.github.com:443/acme/triage.git')).toBe(
      'ssh.github.com/acme/triage'
    )
  })

  it('handles non-github hosts and nested paths', () => {
    expect(normalizeRemote('git@gitlab.com:group/sub/project.git')).toBe(
      'gitlab.com/group/sub/project'
    )
    expect(normalizeRemote('https://example.org/r/repo')).toBe('example.org/r/repo')
  })

  it('returns null for empty or hostless input', () => {
    expect(normalizeRemote('')).toBeNull()
    expect(normalizeRemote('   ')).toBeNull()
    expect(normalizeRemote('justaword')).toBeNull()
  })
})

describe('roomIdentityFromSlug', () => {
  it('is stable and tags github provider', () => {
    const a = roomIdentityFromSlug('github.com/acme/triage')
    const b = roomIdentityFromSlug('github.com/acme/triage')
    expect(a.roomId).toBe(b.roomId)
    expect(a.roomId).toMatch(/^[0-9a-f]{16}$/)
    expect(a.provider).toBe('github')
  })

  it('different repos get different room ids', () => {
    expect(roomIdentityFromSlug('github.com/acme/triage').roomId).not.toBe(
      roomIdentityFromSlug('github.com/acme/other').roomId
    )
  })

  it('tags non-github hosts as generic git', () => {
    expect(roomIdentityFromSlug('gitlab.com/group/project').provider).toBe('git')
  })
})
