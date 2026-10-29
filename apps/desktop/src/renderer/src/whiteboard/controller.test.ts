import { describe, expect, it, vi } from 'vitest'
import type { Effect, NarratorMode, NarratorTransport, PageSnapshot } from '@codeswim/whiteboard'
import {
  WhiteboardController,
  type BuildOutcome,
  type WhiteboardBrowser,
  type WhiteboardCanvas,
  type WhiteboardDeps
} from './controller'
import type { ResearchOutcome } from './research'

const L = (o: object): string => JSON.stringify(o)
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Answers each mode from a queue of replies. */
function scripted(
  replies: Partial<Record<NarratorMode, string[]>>
): NarratorTransport & { sent: string[] } {
  const sent: string[] = []
  return {
    sent,
    async open(mode) {
      return {
        async send(text) {
          sent.push(`${mode}: ${text}`)
          const next = replies[mode]?.shift()
          if (next === undefined) throw new Error(`no reply scripted for ${mode}`)
          return next
        }
      }
    }
  }
}

class FakeCanvas implements WhiteboardCanvas {
  effects: Effect[] = []
  rebuilds = 0
  async render(fx: Effect[]): Promise<void> {
    this.effects.push(...fx)
  }
  rebuild(): void {
    this.rebuilds++
  }
}

interface Setup {
  controller: WhiteboardController
  canvas: FakeCanvas
  deps: WhiteboardDeps
  saved: Map<string, string>
}

function setup(transport: NarratorTransport, overrides: Partial<WhiteboardDeps> = {}): Setup {
  const saved = new Map<string, string>()
  const deps: WhiteboardDeps = {
    connect: async () => transport,
    speaker: { speak: async (_t, onStart) => onStart?.(), cancel: () => {} },
    project: async () => 'Diagrams in this project:\n- architecture/auth.md: Auth',
    build: vi.fn(async (brief: string): Promise<BuildOutcome> => ({
      checkpoint: {
        brief,
        diagrams: [{ path: 'architecture/auth.md', after: '```mermaid\nflowchart LR\n```' }],
        files: [{ file: 'src/auth.ts', additions: 10, deletions: 0 }],
        finalMessage: 'Done.'
      },
      diff: '--- a/src/auth.ts\n+++ b/src/auth.ts\n'
    })),
    openLink: vi.fn(async () => {}),
    showDiff: vi.fn(),
    load: async (ws) => saved.get(ws) ?? null,
    save: async (ws, json) => {
      saved.set(ws, json)
    },
    isVisible: () => true,
    notify: vi.fn(),
    ...overrides
  }
  const controller = new WhiteboardController(deps)
  const canvas = new FakeCanvas()
  controller.attach(canvas)
  return { controller, canvas, deps, saved }
}

describe('WhiteboardController', () => {
  it('speaks and draws a turn, and keeps the transcript', async () => {
    const transport = scripted({
      opener: [L({ say: 'Auth comes down to two pieces.' })],
      main: [
        [
          L({ say: 'The app asks the auth service.' }),
          L({ page: 'Auth' }),
          L({ box: 'auth', at: [1, 0], label: 'Auth', link: 'architecture/auth.md' })
        ].join('\n')
      ]
    })
    const { controller, canvas } = setup(transport)
    await controller.open('/ws')
    await controller.ask('How should login work?')
    const snap = controller.getSnapshot()
    expect(snap.entries.map((e) => [e.who, e.text])).toEqual([
      ['you', 'How should login work?'],
      ['narrator', 'Auth comes down to two pieces. The app asks the auth service.']
    ])
    expect(snap.pages.map((p) => p.name)).toEqual(['Auth'])
    expect(canvas.effects.some((f) => f.fx === 'add' && f.el.kind === 'box')).toBe(true)
    expect(controller.model.named('auth')).toMatchObject({ link: 'architecture/auth.md' })
    // The project's real diagrams go to the main request, not the opener.
    expect(transport.sent.find((s) => s.startsWith('main:'))).toContain('<project>')
    expect(transport.sent.find((s) => s.startsWith('opener:'))).not.toContain('<project>')
    expect(snap.talking).toBe(false)
    expect(snap.timing?.total).toBeGreaterThanOrEqual(0)
  })

  it('builds only after a yes, then walks through the checkpoint', async () => {
    const transport = scripted({
      opener: [L({ say: 'Great, building it.' })],
      main: [
        [
          L({ say: 'Handing it to the agent now.' }),
          L({ build: 'Add an auth service in front of the API.' })
        ].join('\n')
      ],
      walkthrough: [
        [
          L({ page: 'Built: Auth' }),
          L({ say: 'The API now checks tokens with the auth service.' }),
          L({ box: 'auth', at: [1, 0], label: 'Auth', link: 'architecture/auth.md' })
        ].join('\n')
      ]
    })
    const { controller, deps } = setup(transport)
    await controller.open('/ws')
    await controller.ask('Yes, build it')
    await vi.waitFor(() => expect(controller.getSnapshot().lastBuild).not.toBeNull())
    expect(deps.build).toHaveBeenCalledWith(
      'Add an auth service in front of the API.',
      expect.any(String),
      // What was said goes along, so the agent can answer about it later.
      expect.stringContaining('Person: Yes, build it')
    )
    await vi.waitFor(() =>
      expect(controller.getSnapshot().pages.map((p) => p.name)).toContain('Built: Auth')
    )
    await vi.waitFor(() => expect(controller.getSnapshot().talking).toBe(false))
    const walk = transport.sent.find((s) => s.startsWith('walkthrough:'))!
    expect(walk).toContain('<checkpoint>')
    expect(walk).toContain('architecture/auth.md')
    expect(walk).toContain('- src/auth.ts (+10 -0)')
    const snap = controller.getSnapshot()
    expect(snap.lastBuild).toMatchObject({ diagrams: ['architecture/auth.md'], files: 1 })
    controller.showLastDiff()
    expect(deps.showDiff).toHaveBeenCalledWith(
      'Whiteboard build',
      expect.stringContaining('src/auth.ts')
    )
  })

  it('never builds without a yes', async () => {
    const transport = scripted({
      opener: [L({ say: 'Sure.' })],
      main: [[L({ say: 'Here it is.' }), L({ build: 'Sneaky build.' })].join('\n')]
    })
    const { controller, deps } = setup(transport)
    await controller.open('/ws')
    await controller.ask('What would auth look like?')
    await tick(10)
    expect(deps.build).not.toHaveBeenCalled()
    expect(controller.getSnapshot().entries.at(-1)?.text).toContain('do you want me to go ahead')
  })

  it('holds the walkthrough until the view is visible again', async () => {
    let visible = true
    const transport = scripted({
      opener: [L({ say: 'On it.' })],
      main: [[L({ say: 'Building.' }), L({ build: 'Add caching.' })].join('\n')],
      walkthrough: [L({ say: 'Caching is in.' })]
    })
    let finishBuild!: (o: BuildOutcome) => void
    const { controller, deps } = setup(transport, {
      isVisible: () => visible,
      build: () => new Promise<BuildOutcome>((r) => (finishBuild = r))
    })
    await controller.open('/ws')
    await controller.ask('Go ahead')
    expect(controller.getSnapshot().building).toBe('Add caching.')
    visible = false
    finishBuild({
      checkpoint: { brief: 'Add caching.', diagrams: [], files: [], finalMessage: 'ok' },
      diff: ''
    })
    await vi.waitFor(() => expect(controller.getSnapshot().walkthroughReady).toBe(true))
    expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining('Open the Whiteboard'), 'info')
    visible = true
    controller.visible()
    await vi.waitFor(() => expect(controller.getSnapshot().walkthroughReady).toBe(false))
    await vi.waitFor(() =>
      expect(controller.getSnapshot().entries.at(-1)?.text).toBe(
        "It's built. Let me show you what changed. Caching is in."
      )
    )
  })

  it('persists per workspace and restores on open', async () => {
    const transport = scripted({
      opener: [L({ say: 'Okay.' })],
      main: [
        [
          L({ say: 'Two parts.' }),
          L({ page: 'Data' }),
          L({ box: 'db', at: [0, 0], label: 'DB' })
        ].join('\n')
      ]
    })
    const { controller, saved, canvas } = setup(transport)
    await controller.open('/ws-a')
    await controller.ask('Where does data live?')
    await controller.flush()
    expect(JSON.parse(saved.get('/ws-a')!).board.pages[0].name).toBe('Data')

    await controller.open('/ws-b')
    expect(controller.getSnapshot().blank).toBe(true)
    expect(controller.getSnapshot().entries).toEqual([])

    const rebuildsBefore = canvas.rebuilds
    await controller.open('/ws-a')
    expect(controller.getSnapshot().pages.map((p) => p.name)).toEqual(['Data'])
    expect(controller.getSnapshot().entries).toHaveLength(2)
    expect(canvas.rebuilds).toBeGreaterThan(rebuildsBefore)
  })

  it('reports a failed request and reconnects next time', async () => {
    let connects = 0
    const failing = scripted({ opener: [L({ say: 'Hmm.' })] })
    const { controller } = setup(failing, {
      connect: async () => {
        connects++
        return failing
      }
    })
    await controller.open('/ws')
    await controller.ask('Anything?')
    expect(controller.getSnapshot().entries.at(-1)).toMatchObject({ who: 'info' })
    await controller.ask('Again?')
    expect(connects).toBe(2)
  })

  it('a new board clears pages and conversation', async () => {
    const transport = scripted({
      opener: [L({ say: 'Okay.' })],
      main: [
        [L({ say: 'Sketch.' }), L({ page: 'X' }), L({ box: 'a', at: [0, 0], label: 'A' })].join(
          '\n'
        )
      ]
    })
    const { controller } = setup(transport)
    await controller.open('/ws')
    await controller.ask('Draw something')
    controller.newBoard()
    const snap = controller.getSnapshot()
    expect(snap.blank).toBe(true)
    expect(snap.entries).toEqual([])
  })
})

/** A browser panel showing a landing page whose sign-up buttons are `width` wide. */
function fakeBrowser(url: string | null = 'http://localhost:5173/'): WhiteboardBrowser & {
  width: number
  pointed: string[]
  shown: string[]
  reloads: number
  servers: string[]
  started: string[]
  startUrl: string | null
} {
  const b = {
    width: 220,
    pointed: [] as string[],
    shown: [] as string[],
    reloads: 0,
    url,
    snapshot: async (): Promise<PageSnapshot | null> =>
      b.url
        ? {
            url: b.url,
            title: 'Acme',
            elements: [{ role: 'button', text: 'Sign up', box: { width: b.width, height: 44 } }]
          }
        : null,
    currentUrl: () => b.url,
    // With no page open, the app is running at its dev address.
    servers: [] as string[],
    started: [] as string[],
    startUrl: 'http://localhost:5173/' as string | null,
    context: () =>
      b.servers.length ? { servers: b.servers } : { devUrls: ['http://localhost:5173/'] },
    startServer: async (name: string) => {
      b.started.push(name)
      return b.startUrl
    },
    point: async (target: string) => {
      b.pointed.push(target)
    },
    show: async (u: string) => {
      b.shown.push(u)
      b.url = u
    },
    reload: async () => {
      b.reloads++
    }
  }
  return b
}

describe('WhiteboardController with the browser panel', () => {
  it('tells the narrator about the page and points at it while talking', async () => {
    const transport = scripted({
      opener: [L({ say: 'That is your sign-up button.' })],
      main: [
        [
          L({ say: 'It sits right under the heading.' }),
          L({ point: 'Sign up' }),
          L({ show: 'http://localhost:5173/pricing' }),
          L({ show: 'https://somewhere-else.example/' })
        ].join('\n')
      ]
    })
    const browser = fakeBrowser()
    const { controller } = setup(transport, { browser })
    await controller.open('/ws')
    await controller.ask('Where is the sign-up button?')
    const main = transport.sent.find((s) => s.startsWith('main:'))!
    expect(main).toContain('<page>')
    expect(main).toContain('- button "Sign up" 220×44')
    expect(browser.pointed).toEqual(['Sign up'])
    // Only the running app (or the site already showing) opens.
    expect(browser.shown).toEqual(['http://localhost:5173/pricing'])
    // Page lines never touch the board.
    expect(controller.getSnapshot().blank).toBe(true)
  })

  it('puts a screenshot of the page on the board and circles part of it', async () => {
    const transport = scripted({
      opener: [L({ say: 'Here it is.' })],
      main: [
        [
          L({ say: 'This is your landing page.' }),
          L({ page: 'Landing' }),
          L({ shot: 'landing', at: [0, 0], label: 'Landing page' }),
          L({ say: 'The sign-up button is up top.' }),
          L({ circle: 'landing', on: 'Sign up' })
        ].join('\n')
      ]
    })
    const captured: string[] = []
    const browser: WhiteboardBrowser = {
      ...fakeBrowser(),
      capture: async () => {
        captured.push('shot')
        return {
          file: 'shot-abc-123456.jpg',
          width: 1200,
          height: 800,
          marks: [{ text: 'Sign up', x: 0.4, y: 0.1, w: 0.2, h: 0.1 }]
        }
      }
    }
    const { controller, canvas, saved } = setup(transport, { browser })
    await controller.open('/ws')
    await controller.ask('Show me the landing page on the board.')
    expect(captured).toEqual(['shot'])
    const shot = controller.model.named('landing')
    expect(shot).toMatchObject({ kind: 'shot', label: 'Landing page' })
    expect(canvas.effects.map((f) => f.fx)).toContain('circle')
    await controller.flush()
    // The board keeps the picture's file name, never the picture.
    expect(saved.get('/ws')).toContain('shot-abc-123456.jpg')
    expect(saved.get('/ws')).not.toContain('base64')
  })

  it('takes no screenshot without a page open', async () => {
    const transport = scripted({
      opener: [L({ say: 'Sure.' })],
      main: [L({ shot: 'landing', at: [0, 0] })]
    })
    let captures = 0
    const browser: WhiteboardBrowser = {
      ...fakeBrowser(null),
      capture: async () => {
        captures++
        return null
      }
    }
    const { controller } = setup(transport, { browser })
    await controller.open('/ws')
    await controller.ask('Put the page on the board.')
    expect(captures).toBe(0)
    expect(controller.model.named('landing')).toBeUndefined()
  })

  it('mentions the running app when no page is open', async () => {
    const transport = scripted({ opener: [L({ say: 'Sure.' })], main: [L({ say: 'Okay.' })] })
    const { controller } = setup(transport, { browser: fakeBrowser(null) })
    await controller.open('/ws')
    await controller.ask('How does the landing page look?')
    expect(transport.sent.find((s) => s.startsWith('main:'))).toContain(
      'running at http://localhost:5173/'
    )
  })

  it('starts the dev server it offered, opens it, and answers again with the page in view', async () => {
    const transport = scripted({
      opener: [L({ say: 'Let me pull that up.' }), L({ say: 'Here it is.' })],
      main: [
        [L({ say: 'Starting your dev server.' }), L({ start: 'dev' })].join('\n'),
        [L({ say: 'Here is your landing page.' }), L({ point: 'Sign up' })].join('\n')
      ]
    })
    const browser = fakeBrowser(null)
    browser.servers = ['dev']
    const { controller } = setup(transport, { browser })
    await controller.open('/ws')
    await controller.ask('Show me the landing page')
    await vi.waitFor(() =>
      expect(transport.sent.filter((s) => s.startsWith('main:'))).toHaveLength(2)
    )
    await vi.waitFor(() => expect(controller.getSnapshot().talking).toBe(false))
    const [first, second] = transport.sent.filter((s) => s.startsWith('main:'))
    expect(first).toContain('{"start":"dev"}')
    expect(browser.started).toEqual(['dev'])
    expect(browser.shown).toEqual(['http://localhost:5173/'])
    expect(second).toContain("(It's open beside the board now.) Show me the landing page")
    expect(second).toContain('- button "Sign up" 220×44')
    expect(browser.pointed).toEqual(['Sign up'])
    expect(controller.getSnapshot().entries.map((e) => e.text)).toContain(
      'Opened http://localhost:5173/ beside the board.'
    )
  })

  it("never starts a run it didn't offer, and says so when a server prints no address", async () => {
    const transport = scripted({
      opener: [L({ say: 'Sure.' }), L({ say: 'Sure.' })],
      main: [
        [L({ say: 'Deploying.' }), L({ start: 'deploy' })].join('\n'),
        [L({ say: 'Starting it.' }), L({ start: 'dev' })].join('\n')
      ]
    })
    const browser = fakeBrowser(null)
    browser.servers = ['dev']
    browser.startUrl = null
    const { controller } = setup(transport, { browser })
    await controller.open('/ws')
    await controller.ask('Show me the app')
    await tick(10)
    expect(browser.started).toEqual([])
    await controller.ask('Show me the app')
    await vi.waitFor(() =>
      expect(controller.getSnapshot().entries.at(-1)?.text).toContain(
        "didn't print a local address"
      )
    )
    expect(browser.started).toEqual(['dev'])
    expect(browser.shown).toEqual([])
  })

  it('after a build, "make them even wider" builds, and the walkthrough gets measured changes', async () => {
    const browser = fakeBrowser()
    const transport = scripted({
      opener: [L({ say: 'Great.' }), L({ say: 'On it.' })],
      main: [
        [L({ say: 'Building.' }), L({ build: 'Widen the sign-up buttons to 260 pixels.' })].join(
          '\n'
        ),
        [
          L({ say: 'Making them wider.' }),
          L({ build: 'Widen the sign-up buttons to 300 pixels.' })
        ].join('\n')
      ],
      walkthrough: [
        [L({ say: 'They are wider now.' }), L({ point: 'Sign up' })].join('\n'),
        L({ say: 'Even wider now.' })
      ]
    })
    const builds: string[] = []
    const { controller } = setup(transport, {
      browser,
      build: vi.fn(async (brief: string): Promise<BuildOutcome> => {
        builds.push(brief)
        browser.width += 40
        return { checkpoint: { brief, diagrams: [], files: [], finalMessage: 'Done.' }, diff: '' }
      })
    })
    await controller.open('/ws')
    await controller.ask('Yes, build it')
    await vi.waitFor(() =>
      expect(transport.sent.some((s) => s.startsWith('walkthrough:'))).toBe(true)
    )
    await vi.waitFor(() => expect(controller.getSnapshot().talking).toBe(false))
    const walk = transport.sent.find((s) => s.startsWith('walkthrough:'))!
    expect(browser.reloads).toBe(1)
    expect(walk).toContain('Measured changes:\n- button "Sign up": size 220×44 → 260×44 px')
    expect(browser.pointed).toEqual(['Sign up'])

    // No yes needed for a direct follow-up change.
    await controller.ask('make them even wider')
    await vi.waitFor(() => expect(builds).toHaveLength(2))
    await vi.waitFor(() =>
      expect(transport.sent.filter((s) => s.startsWith('walkthrough:'))).toHaveLength(2)
    )
    expect(transport.sent.filter((s) => s.startsWith('walkthrough:'))[1]).toContain(
      'size 260×44 → 300×44 px'
    )
  })
})

describe('the follow-up go-ahead', () => {
  it('lasts two questions after a walkthrough and is not restored from a saved board', async () => {
    const yesBuild = (w: number): string =>
      [L({ say: 'Okay.' }), L({ build: `Widen the buttons to ${w} pixels.` })].join('\n')
    const transport = scripted({
      opener: Array(6).fill(L({ say: 'Sure.' })),
      main: [
        yesBuild(260),
        L({ say: 'They are blue.' }),
        L({ say: 'Fine.' }),
        yesBuild(300),
        yesBuild(320)
      ],
      walkthrough: [L({ say: 'Built.' })]
    })
    const { controller, deps, saved } = setup(transport)
    await controller.open('/ws')
    await controller.ask('Yes, build it')
    await vi.waitFor(() =>
      expect(transport.sent.some((s) => s.startsWith('walkthrough:'))).toBe(true)
    )
    await vi.waitFor(() => expect(controller.getSnapshot().talking).toBe(false))
    await controller.ask('What color are they?')
    await controller.ask('And the heading?')
    // Two questions later, a change request needs a yes again.
    await controller.ask('make them wider')
    await tick(10)
    expect(deps.build).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().entries.at(-1)?.text).toContain('do you want me to go ahead')

    // A board restored from disk carries its last build, but not the go-ahead.
    await controller.flush()
    const fresh = setup(scripted({ opener: [L({ say: 'Sure.' })], main: [yesBuild(320)] }))
    fresh.saved.set('/ws', saved.get('/ws')!)
    await fresh.controller.open('/ws')
    expect(fresh.controller.getSnapshot().lastBuild).not.toBeNull()
    await fresh.controller.ask('make them wider')
    await tick(10)
    expect(fresh.deps.build).not.toHaveBeenCalled()
  })
})

describe('the narrator reads code and sends the agent to look', () => {
  it('puts the files a question names in the main request', async () => {
    const transport = scripted({
      opener: [L({ say: 'Sure.' })],
      main: [L({ say: 'It logs you in.' })]
    })
    const files = vi.fn(async (q: string) =>
      q.includes('auth.ts') ? '--- src/auth.ts\nexport {}' : ''
    )
    const { controller } = setup(transport, { files })
    await controller.open('/ws')
    await controller.ask('What does auth.ts do?')
    expect(files).toHaveBeenCalledWith('What does auth.ts do?')
    expect(transport.sent.find((s) => s.startsWith('main:'))).toContain('<files>\n--- src/auth.ts')
    expect(transport.sent.find((s) => s.startsWith('opener:'))).not.toContain('<files>')
  })

  it('sends a research line to the read-only agent and reports what it found', async () => {
    const transport = scripted({
      opener: [L({ say: 'Let me check.' }), L({ say: 'Here is what it found.' })],
      main: [
        [
          L({ say: 'Let me have the agent check that.' }),
          L({ research: 'Where are permissions checked?' })
        ].join('\n'),
        [
          L({ say: 'They are checked in one middleware.' }),
          L({ box: 'mw', at: [1, 0], label: 'Middleware', link: 'src/middleware.ts' })
        ].join('\n')
      ]
    })
    let release!: () => void
    const research = vi.fn(
      (question: string) =>
        new Promise<ResearchOutcome>((r) => {
          release = () =>
            r({
              question,
              answer: 'In src/middleware.ts, checkAccess() runs first.',
              files: ['src/middleware.ts']
            })
        })
    )
    const { controller } = setup(transport, { research })
    await controller.open('/ws')
    await controller.ask('Where do we check permissions?')
    await vi.waitFor(() =>
      expect(controller.getSnapshot().researching).toBe('Where are permissions checked?')
    )
    expect(controller.getSnapshot().entries.map((e) => e.text)).toContain(
      'Looking into it: Where are permissions checked?'
    )
    release()
    await vi.waitFor(() =>
      expect(transport.sent.filter((s) => s.startsWith('main:'))).toHaveLength(2)
    )
    await vi.waitFor(() => expect(controller.getSnapshot().talking).toBe(false))
    const report = transport.sent.filter((s) => s.startsWith('main:'))[1]
    expect(report).toContain('<research>')
    expect(report).toContain('checkAccess() runs first')
    expect(report).toContain('- src/middleware.ts')
    expect(controller.getSnapshot().researching).toBeNull()
    expect(controller.model.named('mw')).toMatchObject({ link: 'src/middleware.ts' })
  })

  it('stops a look on request, and runs one at a time', async () => {
    const transport = scripted({
      opener: [L({ say: 'Let me check.' }), L({ say: 'Let me check.' })],
      main: [
        [L({ say: 'Checking.' }), L({ research: 'First question' })].join('\n'),
        [L({ say: 'Checking.' }), L({ research: 'Second question' })].join('\n')
      ]
    })
    const research = vi.fn(
      (question: string, signal: AbortSignal) =>
        new Promise<ResearchOutcome>((r) =>
          signal.addEventListener('abort', () =>
            r({ question, answer: '', files: [], stopped: true })
          )
        )
    )
    const { controller } = setup(transport, { research })
    await controller.open('/ws')
    await controller.ask('first?')
    await vi.waitFor(() => expect(controller.getSnapshot().researching).toBe('First question'))
    await controller.ask('second?')
    await tick(10)
    expect(research).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().entries.at(-1)?.text).toContain(
      'Still looking into "First question"'
    )
    controller.cancelResearch()
    await vi.waitFor(() => expect(controller.getSnapshot().researching).toBeNull())
    expect(controller.getSnapshot().entries.at(-1)?.text).toBe('Stopped looking into it.')
  })

  it('tags what was said with the time and the chat session', async () => {
    const transport = scripted({ opener: [L({ say: 'Sure.' })], main: [L({ say: 'Okay.' })] })
    const { controller } = setup(transport, { chatSession: () => 'ses_1' })
    await controller.open('/ws')
    const before = Date.now()
    await controller.ask('Hello')
    for (const e of controller.getSnapshot().entries) {
      expect(e.session).toBe('ses_1')
      expect(e.at).toBeGreaterThanOrEqual(before)
    }
  })
})
