import { describe, expect, it } from 'vitest'
import {
  clean,
  parseLine,
  parseReply,
  toBuild,
  toCell,
  toCmd,
  toColor,
  toGeo,
  toLink,
  toSay
} from './protocol'

describe('parseLine', () => {
  it('parses one JSON object per line', () => {
    expect(parseLine('{"say":"Hello there."}')).toEqual({ say: 'Hello there.' })
  })

  it('drops code fences, stray brackets and broken JSON', () => {
    expect(parseLine('```json')).toBeNull()
    expect(parseLine('```')).toBeNull()
    expect(parseLine('~~~')).toBeNull()
    expect(parseLine('}')).toBeNull()
    expect(parseLine('],')).toBeNull()
    expect(parseLine('{"say": "unterminated')).toBeNull()
    expect(parseLine('[1,2]')).toBeNull()
    expect(parseLine('')).toBeNull()
  })

  it('turns plain prose into a spoken sentence, without markup', () => {
    expect(parseLine('So the **API** talks to the <b>database</b>.')).toEqual({
      say: 'So the API talks to the database .'
    })
  })
})

describe('parseReply', () => {
  it('handles CRLF and fenced replies', () => {
    const reply = '```json\r\n{"say":"One."}\r\n{"box":"a","at":[0,0],"label":"A"}\r\n```\r\n'
    expect(parseReply(reply)).toEqual([{ say: 'One.' }, { box: 'a', at: [0, 0], label: 'A' }])
  })
})

describe('clean', () => {
  it('strips HTML and markdown', () => {
    expect(clean('<div class="x">API</div> `server` **bold**')).toBe('API server bold')
  })

  it('cuts long labels at a word boundary', () => {
    expect(clean('Authentication and session management service', 30)).toBe(
      'Authentication and session'
    )
    expect(clean('Supercalifragilisticexpialidocious', 10)).toBe('Supercalif')
  })
})

describe('colors and shapes', () => {
  it('maps near misses onto tldraw colors', () => {
    expect(toColor('gray')).toBe('grey')
    // tldraw has no light grey, so it falls back rather than crashing the canvas.
    expect(toColor('light gray')).toBe('blue')
    expect(toColor('purple')).toBe('violet')
    expect(toColor('Light Blue')).toBe('light-blue')
    expect(toColor('chartreuse')).toBe('blue')
    expect(toColor(undefined, 'grey')).toBe('grey')
  })

  it('maps unknown shapes to a rectangle', () => {
    expect(toGeo('circle')).toBe('ellipse')
    expect(toGeo('cylinder')).toBe('rectangle')
    expect(toGeo('hexagon')).toBe('hexagon')
  })
})

describe('toCell', () => {
  it('rounds, clamps and defaults', () => {
    expect(toCell([1.4, 2.6])).toEqual([1, 3])
    expect(toCell([-3, 99])).toEqual([0, 12])
    expect(toCell('nope')).toEqual([0, 0])
    expect(toCell(['x', 1])).toEqual([0, 1])
  })
})

describe('toLink', () => {
  it('accepts workspace-relative paths only', () => {
    expect(toLink('architecture/auth.md')).toBe('architecture/auth.md')
    expect(toLink('./flows/login.md')).toBe('flows/login.md')
    expect(toLink('/etc/passwd')).toBeUndefined()
    expect(toLink('../secrets.md')).toBeUndefined()
    expect(toLink('architecture/../../x.md')).toBeUndefined()
    expect(toLink('https://example.com/a.md')).toBeUndefined()
    expect(toLink('C:\\x.md')).toBeUndefined()
    expect(toLink(42)).toBeUndefined()
  })
})

describe('toCmd', () => {
  it('translates a box, with link and shape', () => {
    expect(
      toCmd({
        box: 'Auth',
        at: [1, 0],
        label: 'Auth service',
        color: 'gray',
        shape: 'cloud',
        link: 'architecture/auth.md'
      })
    ).toEqual({
      op: 'box',
      name: 'auth',
      at: [1, 0],
      label: 'Auth service',
      color: 'grey',
      geo: 'cloud',
      link: 'architecture/auth.md'
    })
  })

  it('drops a bad link but keeps the box', () => {
    const cmd = toCmd({ box: 'a', at: [0, 0], label: 'A', link: '../x' })
    expect(cmd).toMatchObject({ op: 'box', name: 'a' })
    expect(cmd).not.toHaveProperty('link')
  })

  it('translates arrows, rejecting self-loops', () => {
    expect(toCmd({ arrow: ['a', 'b'], label: 'calls', back: true })).toEqual({
      op: 'arrow',
      from: 'a',
      to: 'b',
      label: 'calls',
      back: true
    })
    expect(toCmd({ arrow: ['a', 'a'] })).toBeNull()
    expect(toCmd({ arrow: ['a'] })).toBeNull()
  })

  it('translates options with at most two pros and cons', () => {
    expect(
      toCmd({
        option: 'pg',
        at: [1, 2],
        label: 'Postgres',
        pros: ['SQL', 'Mature', 'Extra'],
        cons: ['Ops']
      })
    ).toEqual({
      op: 'option',
      name: 'pg',
      at: [1, 2],
      label: 'Postgres',
      pros: ['SQL', 'Mature'],
      cons: ['Ops'],
      color: 'blue'
    })
  })

  it('normalizes group corners', () => {
    expect(toCmd({ group: 'be', from: [2, 1], to: [1, 0], label: 'Backend' })).toEqual({
      op: 'group',
      name: 'be',
      from: [1, 0],
      to: [2, 1],
      label: 'Backend'
    })
  })

  it('keeps arrow names intact when removing an arrow', () => {
    expect(toCmd({ remove: 'API->DB' })).toEqual({ op: 'remove', name: 'api->db' })
  })

  it('translates the rest', () => {
    expect(toCmd({ pick: 'pg' })).toEqual({ op: 'pick', name: 'pg' })
    expect(toCmd({ page: 'Multiplayer' })).toEqual({ op: 'page', name: 'Multiplayer' })
    expect(toCmd({ highlight: 'api' })).toEqual({ op: 'highlight', name: 'api' })
    expect(toCmd({ move: 'api', at: [2, 1] })).toEqual({ op: 'move', name: 'api', at: [2, 1] })
    expect(toCmd({ clear: true })).toEqual({ op: 'clear' })
    expect(toCmd({ link: 'api', to: 'architecture/api.md' })).toEqual({
      op: 'link',
      name: 'api',
      to: 'architecture/api.md'
    })
    expect(toCmd({ link: 'api', to: 'https://x' })).toBeNull()
    expect(toCmd({ say: 'hi' })).toBeNull()
    expect(toCmd({ clear: 'yes' })).toBeNull()
  })
})

describe('toSay / toBuild', () => {
  it('cleans spoken sentences', () => {
    expect(toSay({ say: 'Use the `auth` service.' })).toBe('Use the auth service.')
    expect(toSay({ say: '...' })).toBeNull()
    expect(toSay({ box: 'a' })).toBeNull()
  })

  it('reads build briefs', () => {
    expect(toBuild({ build: ' Add a login page. ' })).toBe('Add a login page.')
    expect(toBuild({ build: '' })).toBeNull()
    expect(toBuild({ say: 'x' })).toBeNull()
  })
})
