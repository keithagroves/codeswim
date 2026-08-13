import { describe, expect, it, vi } from 'vitest'
import {
  defaultRoom,
  formatMessages,
  readChat,
  resolveChatConfig,
  sendChat,
  validateChatRoom,
  type ChatConfig,
  type ChatIo,
  type ChatMessage
} from './chat'

const config: ChatConfig = {
  partyHost: '127.0.0.1:8788',
  slug: 'github.com/acme/triage',
  publicRoomId: 'public-room-id',
  teamRoomId: 'team-room-id',
  token: 'gh-token',
  agentName: 'Codeswim Agent'
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('resolveChatConfig', () => {
  it('returns null when the workspace has no room identity in env', () => {
    expect(resolveChatConfig({})).toBeNull()
  })

  it('builds a config from env vars, defaulting token and agent name', () => {
    const result = resolveChatConfig({
      CODESWIM_CHAT_PARTY_HOST: '127.0.0.1:8788',
      CODESWIM_CHAT_SLUG: 'github.com/acme/triage',
      CODESWIM_CHAT_PUBLIC_ROOM_ID: 'pub',
      CODESWIM_CHAT_TEAM_ROOM_ID: 'team'
    })
    expect(result).toEqual({
      partyHost: '127.0.0.1:8788',
      slug: 'github.com/acme/triage',
      publicRoomId: 'pub',
      teamRoomId: 'team',
      token: null,
      agentName: 'Codeswim Agent'
    })
  })

  it('picks up an explicit token and agent name', () => {
    const result = resolveChatConfig({
      CODESWIM_CHAT_PARTY_HOST: 'h',
      CODESWIM_CHAT_SLUG: 's',
      CODESWIM_CHAT_PUBLIC_ROOM_ID: 'p',
      CODESWIM_CHAT_TEAM_ROOM_ID: 't',
      CODESWIM_CHAT_TOKEN: 'secret',
      CODESWIM_CHAT_AGENT_NAME: 'Bot'
    })
    expect(result?.token).toBe('secret')
    expect(result?.agentName).toBe('Bot')
  })
})

describe('defaultRoom / validateChatRoom', () => {
  it('defaults to team when signed in, public otherwise', () => {
    expect(defaultRoom(config)).toBe('team')
    expect(defaultRoom({ ...config, token: null })).toBe('public')
  })

  it('validates room values', () => {
    expect(validateChatRoom('public')).toBeNull()
    expect(validateChatRoom('team')).toBeNull()
    expect(validateChatRoom('collab')).toMatch(/room must be/)
    expect(validateChatRoom(undefined)).toMatch(/room must be/)
  })
})

describe('readChat', () => {
  it('refuses to read the team room without a token', async () => {
    const io: ChatIo = { fetch: vi.fn() }
    const result = await readChat('team', { ...config, token: null }, io)
    expect(result).toEqual({ ok: false, error: expect.stringContaining('Not signed in') })
    expect(io.fetch).not.toHaveBeenCalled()
  })

  it('requests the public room with mode=public, no auth header', async () => {
    const messages: ChatMessage[] = [
      { id: '1', userId: 'u1', name: 'Sam', text: 'hi', sentAt: 1700000000000 }
    ]
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ messages }))
    const io: ChatIo = { fetch: fetchMock }

    const result = await readChat('public', config, io)
    expect(result).toEqual({ ok: true, value: messages })

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/parties/codeswim-room/public-room-id')
    expect(String(url)).toContain('mode=public')
    expect(String(url)).toContain(`slug=${encodeURIComponent(config.slug)}`)
    expect((init.headers as Record<string, string>).authorization).toBeUndefined()
  })

  it('requests the team room with mode=collab and a bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ messages: [] }))
    const io: ChatIo = { fetch: fetchMock }

    await readChat('team', config, io)

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/parties/codeswim-room/team-room-id')
    expect(String(url)).toContain('mode=collab')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer gh-token')
  })

  it('turns a 403 into a clear collaborator-access message', async () => {
    const io: ChatIo = { fetch: vi.fn().mockResolvedValue(new Response(null, { status: 403 })) }
    const result = await readChat('team', config, io)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('collaborator')
  })

  it('turns a room-mismatch 400 into a stale-config message', async () => {
    const io: ChatIo = {
      fetch: vi.fn().mockResolvedValue(jsonResponse({ error: 'room-mismatch' }, 400))
    }
    const result = await readChat('public', config, io)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/stale/)
  })
})

describe('sendChat', () => {
  it('rejects empty text without making a request', async () => {
    const io: ChatIo = { fetch: vi.fn() }
    const result = await sendChat('public', '   ', config, io)
    expect(result).toEqual({ ok: false, error: 'text is required' })
    expect(io.fetch).not.toHaveBeenCalled()
  })

  it('posts trimmed text with the agent display name and returns the created message', async () => {
    const created: ChatMessage = {
      id: 'm1',
      userId: 'http:x',
      name: 'Codeswim Agent',
      text: 'build is green',
      sentAt: 1700000000000
    }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: created }, 201))
    const io: ChatIo = { fetch: fetchMock }

    const result = await sendChat('public', '  build is green  ', config, io)
    expect(result).toEqual({ ok: true, value: created })

    const [url, init] = fetchMock.mock.calls[0]
    expect(init.method).toBe('POST')
    expect(new URL(String(url)).searchParams.get('name')).toBe('Codeswim Agent')
    expect(JSON.parse(init.body as string)).toEqual({ text: 'build is green' })
  })

  it('refuses to post to the team room without a token', async () => {
    const io: ChatIo = { fetch: vi.fn() }
    const result = await sendChat('team', 'hello', { ...config, token: null }, io)
    expect(result.ok).toBe(false)
    expect(io.fetch).not.toHaveBeenCalled()
  })
})

describe('formatMessages', () => {
  it('says when a room is empty', () => {
    expect(formatMessages('public', [])).toBe('No messages yet in the public room.')
  })

  it('renders one line per message with an ISO timestamp', () => {
    const messages: ChatMessage[] = [
      { id: '1', userId: 'u1', name: 'Sam', text: 'hi', sentAt: 1700000000000 }
    ]
    const out = formatMessages('team', messages)
    expect(out).toContain('team room (1 message):')
    expect(out).toContain('Sam: hi')
    expect(out).toContain(new Date(1700000000000).toISOString())
  })
})
