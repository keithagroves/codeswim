import { describe, expect, it } from 'vitest'
import { BoardModel } from './board'
import { agreesToBuild, asksToClear, canPick, guardCmd, similar } from './guards'

describe('asksToClear', () => {
  it('only when the person asks for a fresh start', () => {
    expect(asksToClear("Let's start over")).toBe(true)
    expect(asksToClear('Wipe the board and show me something else')).toBe(true)
    expect(asksToClear('Can you clear this page?')).toBe(true)
    expect(asksToClear('How does auth work?')).toBe(false)
    expect(asksToClear('Now add multiplayer')).toBe(false)
  })
})

describe('agreesToBuild', () => {
  it('takes an explicit yes', () => {
    for (const yes of [
      'Yes',
      'yes please',
      'Build it',
      'Go ahead.',
      "Sounds good, let's do it",
      'ok',
      'Ship it!',
      'Yep, build that'
    ]) {
      expect(agreesToBuild(yes), yes).toBe(true)
    }
  })

  it('rejects hedges, refusals and questions', () => {
    for (const no of [
      'No',
      'Not yet',
      "Yes, but first let's look at auth",
      'Wait, what about caching?',
      'Should we build it?',
      "Don't build it",
      'What does the API look like?',
      ''
    ]) {
      expect(agreesToBuild(no), no).toBe(false)
    }
  })
})

describe('pick guard', () => {
  it('only names an option that was offered and is still on the board', () => {
    const b = new BoardModel()
    b.apply({
      op: 'option',
      name: 'pg',
      at: [0, 0],
      label: 'Postgres',
      pros: [],
      cons: [],
      color: 'blue'
    })
    b.apply({ op: 'box', name: 'api', at: [2, 0], label: 'API', color: 'blue', geo: 'rectangle' })
    expect(canPick(b, 'pg')).toBe(true)
    expect(canPick(b, 'api')).toBe(false)
    expect(canPick(b, 'mongo')).toBe(false)
    expect(guardCmd({ op: 'pick', name: 'api' }, { mayClear: false, board: b })).toBeNull()
    expect(guardCmd({ op: 'clear' }, { mayClear: false, board: b })).toBeNull()
    expect(guardCmd({ op: 'clear' }, { mayClear: true, board: b })).toEqual({ op: 'clear' })
  })
})

describe('similar', () => {
  it('spots a sentence that repeats the opener', () => {
    expect(
      similar(
        'That comes down to speed versus control.',
        'It comes down to speed versus control here.'
      )
    ).toBe(true)
    expect(
      similar('Phaser it is.', 'Phaser handles the physics for you, so start with one scene.')
    ).toBe(false)
    expect(similar('', 'anything')).toBe(false)
    // A short acknowledgement doesn't swallow a real sentence that mentions the same thing.
    expect(
      similar(
        'Postgres it is.',
        'The API writes each session to Postgres and checks it on every request.'
      )
    ).toBe(false)
    expect(similar('Postgres it is.', 'Postgres it is!')).toBe(true)
  })
})
