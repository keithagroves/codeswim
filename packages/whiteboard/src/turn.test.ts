import { describe, expect, it } from 'vitest'
import type { NarratorMode } from './prompts'
import {
  CONFIRM_BUILD,
  composePrompt,
  Turn,
  WALKTHROUGH_OPENER,
  type Action,
  type NarratorTransport,
  type Speaker,
  type TurnDeps,
  type TurnRequest
} from './turn'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Scripted {
  /** Replies per mode, in order (main: one per part). */
  replies: Partial<Record<NarratorMode, string[]>>
  /** Delay before each mode's replies arrive. */
  delay?: Partial<Record<NarratorMode, number>>
}

/** A transport that answers from a script and records what it was sent. */
function fakeTransport(
  script: Scripted
): NarratorTransport & { sent: { mode: NarratorMode; text: string }[]; closed: NarratorMode[] } {
  const sent: { mode: NarratorMode; text: string }[] = []
  const closed: NarratorMode[] = []
  const queues: Partial<Record<NarratorMode, string[]>> = structuredClone(script.replies)
  return {
    sent,
    closed,
    async open(mode) {
      return {
        close: () => closed.push(mode),
        async send(text, signal) {
          sent.push({ mode, text })
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, script.delay?.[mode] ?? 0)
            signal.addEventListener('abort', () => {
              clearTimeout(t)
              reject(new Error('aborted'))
            })
          })
          const next = queues[mode]?.shift()
          if (next === undefined) throw new Error(`no scripted reply for ${mode}`)
          return next
        }
      }
    }
  }
}

/** Speech takes a few ms per sentence; records the order of events. */
function fakeSpeaker(events: string[], ms = 5): Speaker & { cancelled: boolean } {
  const s = {
    cancelled: false,
    async speak(text: string, onStart?: () => void) {
      events.push(`say:${text}`)
      onStart?.()
      await sleep(ms)
    },
    cancel() {
      s.cancelled = true
    }
  }
  return s
}

interface Setup {
  turn: Turn
  events: string[]
  transport: ReturnType<typeof fakeTransport>
  speaker: ReturnType<typeof fakeSpeaker>
  drawn: Action[]
}

function setup(
  script: Scripted,
  req: Partial<TurnRequest> = {},
  deps: Partial<TurnDeps> = {}
): Setup {
  const events: string[] = []
  const transport = fakeTransport(script)
  const speaker = fakeSpeaker(events)
  const drawn: Action[] = []
  const turn = new Turn(
    {
      transport,
      speaker,
      run: async (c) => {
        drawn.push(c)
        events.push(`draw:${c.op}${'name' in c ? `:${c.name}` : ''}`)
      },
      describe: () => '(board)',
      delays: { filler: 1000, gate: 1000 },
      ...deps
    },
    { question: 'How does it work?', history: [], mode: 'talk', ...req }
  )
  return { turn, events, transport, speaker, drawn }
}

const L = (o: object): string => JSON.stringify(o)

describe('Turn', () => {
  it('speaks the opener first and holds drawing until it has played', async () => {
    const { turn, events } = setup({
      replies: {
        opener: [L({ say: 'It comes down to two parts.' })],
        main: [
          [
            L({ say: 'The browser talks to the API.' }),
            L({ box: 'api', at: [1, 0], label: 'API' })
          ].join('\n')
        ]
      },
      // The main answer arrives before the opener: its drawing must still wait.
      delay: { opener: 30, main: 5 }
    })
    const result = await turn.done
    expect(events).toEqual([
      'say:It comes down to two parts.',
      'say:The browser talks to the API.',
      'draw:box:api'
    ])
    expect(result.reply.split('\n')).toHaveLength(3)
    expect(result.timing.firstDrawing).toBeGreaterThanOrEqual(25)
  })

  it('hands each sentence to the speaker to prepare as soon as it is queued', async () => {
    const events: string[] = []
    const prepared: string[] = []
    const transport = fakeTransport({
      replies: {
        opener: [L({ say: 'Opening.' })],
        main: [[L({ say: 'One.' }), L({ say: 'Two.' })].join('\n')]
      }
    })
    const turn = new Turn(
      {
        transport,
        speaker: { ...fakeSpeaker(events, 20), prepare: (t) => prepared.push(t) },
        run: async () => {},
        describe: () => '',
        delays: { filler: 1000, gate: 1000 }
      },
      { question: 'q', history: [], mode: 'talk' }
    )
    await turn.done
    expect(prepared).toEqual(['Opening.', 'One.', 'Two.'])
    // "Two." was prepared before "One." finished speaking.
    expect(events).toEqual(['say:Opening.', 'say:One.', 'say:Two.'])
  })

  it('keeps the opener to one sentence and never lets it draw', async () => {
    const { turn, events } = setup({
      replies: {
        opener: [
          [
            L({ box: 'x', at: [0, 0], label: 'X' }),
            L({ say: 'First.' }),
            L({ say: 'Second.' }),
            L({ pick: 'a' })
          ].join('\n')
        ],
        main: [L({ say: 'Main answer here.' })]
      }
    })
    await turn.done
    expect(events).toEqual(['say:First.', 'say:Main answer here.'])
  })

  it("drops an answer's first sentence when it repeats the opener, keeping its drawing", async () => {
    const { turn, events } = setup({
      replies: {
        opener: [L({ say: 'That comes down to speed versus control.' })],
        main: [
          [
            L({ say: 'It comes down to speed versus control here.' }),
            L({ option: 'a', at: [0, 1], label: 'A' }),
            L({ say: 'Option A is quick.' })
          ].join('\n')
        ]
      },
      delay: { opener: 1, main: 10 }
    })
    await turn.done
    expect(events).toEqual([
      'say:That comes down to speed versus control.',
      'draw:option:a',
      'say:Option A is quick.'
    ])
  })

  it('requests the next part as soon as one arrives, continuing in the same session', async () => {
    const { turn, events, transport } = setup({
      replies: {
        opener: [L({ say: 'Opening.' })],
        main: [
          [L({ say: 'Part one.' }), L({ more: true })].join('\n'),
          [L({ say: 'Part two.' }), L({ box: 'b', at: [0, 0], label: 'B' })].join('\n')
        ]
      }
    })
    await turn.done
    expect(events).toEqual(['say:Opening.', 'say:Part one.', 'say:Part two.', 'draw:box:b'])
    const mains = transport.sent.filter((s) => s.mode === 'main')
    expect(mains).toHaveLength(2)
    expect(mains[1].text.startsWith('(continue)')).toBe(true)
    expect(mains[0].text).toContain('<canvas>\n(board)\n</canvas>')
    // Both hidden sessions are released once the turn is over.
    expect(transport.closed.sort()).toEqual(['main', 'opener'])
  })

  it('only clears when the person asked', async () => {
    const reply = [L({ say: 'Fresh start.' }), L({ clear: true })].join('\n')
    const a = setup(
      { replies: { opener: [L({ say: 'Okay.' })], main: [reply] } },
      { question: 'Now add caching' }
    )
    await a.turn.done
    expect(a.drawn).toEqual([])
    const b = setup(
      { replies: { opener: [L({ say: 'Okay.' })], main: [reply] } },
      { question: "Let's start over" }
    )
    await b.turn.done
    expect(b.drawn).toEqual([{ op: 'clear' }])
  })

  it('passes one research question on, but never from a turn that reports research', async () => {
    const reply = [
      L({ say: 'Let me have the agent check that.' }),
      L({ research: 'Where are permissions checked?' }),
      L({ research: 'And a second one?' })
    ].join('\n')
    const asked = setup({ replies: { opener: [L({ say: 'Let me check.' })], main: [reply] } })
    const r = await asked.turn.done
    expect(r.research).toBe('Where are permissions checked?')
    expect(r.reply).toContain('"research":"Where are permissions checked?"')

    const reporting = setup(
      { replies: { opener: [L({ say: 'Here it is.' })], main: [reply] } },
      { research: 'The agent found: checks live in middleware.' }
    )
    expect((await reporting.turn.done).research).toBeNull()
  })

  it('honors a build line only after an explicit yes', async () => {
    const reply = [
      L({ say: 'Building it now.' }),
      L({ build: 'Add a login page backed by the auth service.' })
    ].join('\n')
    const yes = setup(
      { replies: { opener: [L({ say: 'Great.' })], main: [reply] } },
      { question: 'Yes, build it' }
    )
    const r1 = await yes.turn.done
    expect(r1.build).toBe('Add a login page backed by the auth service.')

    const notAsked = setup(
      { replies: { opener: [L({ say: 'Sure.' })], main: [reply] } },
      { question: 'What about caching?' }
    )
    const r2 = await notAsked.turn.done
    expect(r2.build).toBeNull()
    expect(r2.buildRefused).toBe(true)
    expect(notAsked.events.at(-1)).toBe(`say:${CONFIRM_BUILD}`)
  })

  it('right after a build, a direct change request is the go-ahead', async () => {
    const reply = [
      L({ say: 'Making them wider.' }),
      L({ build: 'Widen the sign-up buttons from 220 to 280 pixels.' })
    ].join('\n')
    const followUp = setup(
      { replies: { opener: [L({ say: 'On it.' })], main: [reply] } },
      { question: 'actually, make them even wider', followUp: true }
    )
    expect((await followUp.turn.done).build).toBe(
      'Widen the sign-up buttons from 220 to 280 pixels.'
    )

    // Without a build to follow up on, the same words still need a yes.
    const fresh = setup(
      { replies: { opener: [L({ say: 'Sure.' })], main: [reply] } },
      { question: 'make the buttons wider' }
    )
    expect((await fresh.turn.done).buildRefused).toBe(true)

    // A question about options is never a go-ahead.
    const asking = setup(
      { replies: { opener: [L({ say: 'Hmm.' })], main: [reply] } },
      { question: 'what if we made them wider?', followUp: true }
    )
    expect((await asking.turn.done).build).toBeNull()
  })

  it('points at the page while the sentence that mentions it is spoken', async () => {
    const reply = [
      L({ say: 'Here is your sign-up button.' }),
      L({ point: 'Sign up' }),
      L({ show: 'http://localhost:5173/pricing' })
    ].join('\n')
    const { turn, drawn, events } = setup({
      replies: { opener: [L({ say: 'Look.' })], main: [reply] }
    })
    const r = await turn.done
    expect(drawn).toEqual([
      { op: 'point', target: 'Sign up', all: false },
      { op: 'show', url: 'http://localhost:5173/pricing' }
    ])
    expect(events.indexOf('say:Here is your sign-up button.')).toBeLessThan(
      events.indexOf('draw:point')
    )
    expect(r.reply).toContain('"point":"Sign up"')
  })

  it('fills a slow silence, and the filler stays out of the result', async () => {
    const { turn, events } = setup(
      {
        replies: { opener: [L({ say: 'Opening.' })], main: [L({ say: 'Answer.' })] },
        delay: { opener: 40, main: 40 }
      },
      {},
      { delays: { filler: 5, gate: 1000 } }
    )
    const result = await turn.done
    expect(events[0]).toMatch(/^say:(Hmm|Okay|Let me|Right)/)
    expect(result.segments.map((s) => s.say)).toEqual(['Opening.', 'Answer.'])
  })

  it('stops talking, drawing and requesting when interrupted', async () => {
    const { turn, events, speaker } = setup({
      replies: { opener: [L({ say: 'Opening.' })], main: [L({ say: 'Never heard.' })] },
      delay: { opener: 5, main: 200 }
    })
    await sleep(20)
    turn.interrupt()
    const result = await turn.done
    expect(result.aborted).toBe(true)
    expect(speaker.cancelled).toBe(true)
    expect(events).toEqual(['say:Opening.'])
  })

  it('reports a failed request instead of throwing', async () => {
    const { turn } = setup({ replies: { opener: [L({ say: 'Opening.' })] } })
    const result = await turn.done
    expect(result.error).toMatch(/no scripted reply/)
    expect(result.aborted).toBe(false)
  })

  it('opens a walkthrough without waiting and never builds from it', async () => {
    const { turn, events, transport } = setup(
      {
        replies: {
          walkthrough: [
            [
              L({ page: 'Built: Auth' }),
              L({ say: 'The login page now calls the auth service.' }),
              L({ build: 'again' })
            ].join('\n')
          ]
        }
      },
      {
        mode: 'walkthrough',
        question: 'Walk me through what you built.',
        checkpoint: 'Design brief:\nAuth'
      }
    )
    const result = await turn.done
    expect(events[0]).toBe(`say:${WALKTHROUGH_OPENER}`)
    expect(events).toContain('draw:page:Built: Auth')
    expect(result.build).toBeNull()
    expect(result.buildRefused).toBe(false)
    expect(transport.sent.map((s) => s.mode)).toEqual(['walkthrough'])
    expect(transport.sent[0].text).toContain('<checkpoint>\nDesign brief:\nAuth\n</checkpoint>')
  })
})

describe('composePrompt', () => {
  it('carries the conversation, project, question and board', () => {
    const text = composePrompt({
      question: 'Add accounts',
      history: [
        { role: 'user', content: 'old question' },
        { role: 'assistant', content: '{"say":"old answer"}' },
        { role: 'user', content: 'recent question' },
        { role: 'assistant', content: '{"say":"recent answer"}' }
      ],
      historyLimit: 2,
      canvas: 'box api',
      project: 'Diagrams: overview.md',
      afterOpener: true
    })
    expect(text).not.toContain('old question')
    expect(text).toContain(
      '<conversation>\nPerson: recent question\nYou:\n{"say":"recent answer"}\n</conversation>'
    )
    expect(text).toContain('<project>\nDiagrams: overview.md\n</project>')
    expect(text).toContain('Add accounts')
    expect(text).toContain('just heard you give a one-sentence summary')
    expect(text.endsWith('<canvas>\nbox api\n</canvas>')).toBe(true)
  })

  it('carries named files and research findings when there are some', () => {
    const text = composePrompt({
      question: 'What does auth.ts do?',
      history: [],
      historyLimit: 0,
      canvas: '',
      files: '--- src/auth.ts\nexport {}',
      research: 'Permissions are checked in middleware.ts.'
    })
    expect(text).toContain('<files>\n--- src/auth.ts\nexport {}\n</files>')
    expect(text).toContain('<research>\nPermissions are checked in middleware.ts.\n</research>')
  })

  it('carries the page beside the board when there is one', () => {
    const text = composePrompt({
      question: 'Do the buttons look right?',
      history: [],
      historyLimit: 0,
      canvas: '',
      page: 'url: http://localhost:5173/'
    })
    expect(text).toContain('<page>\nurl: http://localhost:5173/\n</page>')
    expect(
      composePrompt({ question: 'q', history: [], historyLimit: 0, canvas: '' })
    ).not.toContain('<page>')
  })
})
