import { describe, expect, it } from 'vitest'
import { BoardModel, boundsOf, MAX_SHOTS, type BoxEl, type Effect, type ShotEl } from './board'
import { GRID, toCmd, type Cmd, type ShotImage } from './protocol'

const cmd = (line: Record<string, unknown>): Cmd => {
  const c = toCmd(line)
  if (!c) throw new Error(`not a command: ${JSON.stringify(line)}`)
  return c
}

function boardWith(...lines: Record<string, unknown>[]): BoardModel {
  const b = new BoardModel()
  for (const l of lines) b.apply(cmd(l))
  return b
}

const boxes = (b: BoardModel): BoxEl[] => b.elements().filter((e): e is BoxEl => e.kind === 'box')

describe('pages', () => {
  it('names the first, unnamed page instead of adding one', () => {
    const b = new BoardModel()
    const fx = b.apply(cmd({ page: 'Gameplay' }))
    expect(b.pages).toEqual([{ id: 'p1', name: 'Gameplay' }])
    expect(fx.map((f) => f.fx)).toEqual(['rename', 'add'])
    expect(b.elements()).toMatchObject([{ kind: 'text', role: 'title', text: 'Gameplay' }])
  })

  it('creates a new page once the current one has a drawing, and turns back by name', () => {
    const b = boardWith(
      { page: 'Gameplay' },
      { box: 'ship', at: [0, 0], label: 'Ship' },
      { page: 'Accounts' }
    )
    expect(b.pages.map((p) => p.name)).toEqual(['Gameplay', 'Accounts'])
    expect(b.currentPage.name).toBe('Accounts')
    const fx = b.apply(cmd({ page: 'gameplay' }))
    expect(fx).toEqual([{ fx: 'page', page: { id: 'p1', name: 'Gameplay' } }])
    expect(b.currentPage.name).toBe('Gameplay')
  })

  it('keeps names per page, so a stand-in box can share a name', () => {
    const b = boardWith(
      { page: 'Game' },
      { box: 'game', at: [0, 0], label: 'Game' },
      { page: 'Backend' },
      { box: 'game', at: [0, 0], label: 'Game' }
    )
    expect(boxes(b)).toHaveLength(1)
    expect(b.named('game')?.page).toBe(b.currentPage.id)
  })

  it('only joins boxes on the current page with arrows', () => {
    const b = boardWith(
      { page: 'One' },
      { box: 'a', at: [0, 0], label: 'A' },
      { page: 'Two' },
      { box: 'b', at: [0, 0], label: 'B' }
    )
    expect(b.apply(cmd({ arrow: ['a', 'b'] }))).toEqual([])
  })
})

describe('placement', () => {
  it('moves a box out of an occupied cell', () => {
    const b = boardWith({ box: 'a', at: [1, 1], label: 'A' }, { box: 'b', at: [1, 1], label: 'B' })
    const [a, c] = boxes(b)
    expect(a).toMatchObject({ x: GRID.col, y: GRID.row })
    expect(c.x === a.x && c.y === a.y).toBe(false)
  })

  it('never stacks boxes, even when the model asks for the same cell many times', () => {
    const b = new BoardModel()
    for (let i = 0; i < 40; i++) b.apply(cmd({ box: `b${i}`, at: [0, 0], label: `B${i}` }))
    const bs = boxes(b)
    expect(bs).toHaveLength(40)
    for (let i = 0; i < bs.length; i++) {
      for (let j = i + 1; j < bs.length; j++) {
        const p = boundsOf(bs[i])!
        const q = boundsOf(bs[j])!
        const hit = p.x < q.x + q.w && p.x + p.w > q.x && p.y < q.y + q.h && p.y + p.h > q.y
        expect(hit, `${bs[i].name} overlaps ${bs[j].name}`).toBe(false)
      }
    }
  })

  it('points at a box that already exists instead of drawing it twice', () => {
    const b = boardWith({ box: 'a', at: [0, 0], label: 'A' })
    const fx = b.apply(cmd({ box: 'a', at: [3, 3], label: 'A again' }))
    expect(fx).toEqual([{ fx: 'pulse', id: 'p1~box~a', ms: 900 }])
    expect(boxes(b)).toHaveLength(1)
  })

  it('curves an arrow that would run through another box', () => {
    const b = boardWith(
      { box: 'a', at: [0, 0], label: 'A' },
      { box: 'mid', at: [1, 0], label: 'Mid' },
      { box: 'c', at: [2, 0], label: 'C' }
    )
    const [fx] = b.apply(cmd({ arrow: ['a', 'c'] }))
    expect(fx).toMatchObject({ fx: 'add', el: { kind: 'arrow' } })
    expect((fx as Extract<Effect, { fx: 'add' }>).el).toHaveProperty('bend')
    expect(((fx as Extract<Effect, { fx: 'add' }>).el as { bend: number }).bend).not.toBe(0)
    const [straight] = b.apply(cmd({ arrow: ['a', 'mid'] }))
    expect(((straight as Extract<Effect, { fx: 'add' }>).el as { bend: number }).bend).toBe(0)
  })

  it('draws return paths curved and dashed, and dedupes arrows', () => {
    const b = boardWith({ box: 'a', at: [0, 0], label: 'A' }, { box: 'b', at: [1, 0], label: 'B' })
    b.apply(cmd({ arrow: ['b', 'a'], back: true }))
    expect(b.named('b->a')).toMatchObject({ dashed: true, bend: -60 })
    expect(b.apply(cmd({ arrow: ['b', 'a'] }))).toMatchObject([{ fx: 'pulse' }])
  })
})

describe('trade-offs', () => {
  const tradeoff = (): BoardModel =>
    boardWith(
      { page: 'Data' },
      { option: 'pg', at: [0, 1], label: 'Postgres', pros: ['SQL'], cons: ['Ops work'] },
      { option: 'fb', at: [1, 1], label: 'Firebase', pros: ['Live updates'], cons: ['Lock-in'] }
    )

  it('writes pros and cons under each option', () => {
    const b = tradeoff()
    const notes = b.elements().filter((e) => e.kind === 'text' && e.owner === 'pg')
    expect(notes.map((n) => (n.kind === 'text' ? n.text : ''))).toEqual(['+ SQL', '− Ops work'])
    expect(b.offered).toEqual(['pg', 'fb'])
  })

  it('a pick turns the choice green with a tick and fades the alternatives', () => {
    const b = tradeoff()
    const fx = b.apply(cmd({ pick: 'fb' }))
    expect(b.named('fb')).toMatchObject({ color: 'green', label: '✓ Firebase', picked: true })
    expect(b.named('pg')).toMatchObject({ opacity: 0.3 })
    expect(fx.map((f) => f.fx)).toEqual(['update', 'fade'])
  })

  it('ignores a pick of something that was never offered', () => {
    const b = tradeoff()
    b.apply(cmd({ box: 'api', at: [3, 0], label: 'API' }))
    expect(b.apply(cmd({ pick: 'api' }))).toEqual([])
    expect(b.apply(cmd({ pick: 'mongo' }))).toEqual([])
  })

  it('moving the picked option into the design erases its comparison', () => {
    const b = tradeoff()
    b.apply(cmd({ pick: 'fb' }))
    const fx = b.apply(cmd({ move: 'fb', at: [2, 0] }))
    expect(fx[0]).toMatchObject({ fx: 'delete' })
    expect(b.named('pg')).toBeUndefined()
    expect(b.elements().some((e) => e.kind === 'text' && e.role !== 'title')).toBe(false)
    expect(b.named('fb')).toMatchObject({ x: 2 * GRID.col, y: 0, picked: true })
    expect(b.named('fb')).not.toHaveProperty('option')
  })
})

describe('remove and clear', () => {
  it('removing a box removes its arrows', () => {
    const b = boardWith(
      { box: 'a', at: [0, 0], label: 'A' },
      { box: 'b', at: [1, 0], label: 'B' },
      { arrow: ['a', 'b'] }
    )
    const fx = b.apply(cmd({ remove: 'b' }))
    expect(fx).toEqual([{ fx: 'delete', ids: ['p1~box~b', 'p1~arrow~a->b'], ms: 300 }])
    expect(b.elements().map((e) => e.id)).toEqual(['p1~box~a'])
  })

  it('removes an arrow by name', () => {
    const b = boardWith(
      { box: 'a', at: [0, 0], label: 'A' },
      { box: 'b', at: [1, 0], label: 'B' },
      { arrow: ['a', 'b'] }
    )
    b.apply(cmd({ remove: 'a->b' }))
    expect(b.named('a->b')).toBeUndefined()
    expect(b.named('a')).toBeDefined()
  })

  it('clear wipes the drawing but keeps the title', () => {
    const b = boardWith(
      { page: 'Plan' },
      { box: 'a', at: [0, 0], label: 'A' },
      { note: 'hi', at: [1, 0] }
    )
    b.apply({ op: 'clear' })
    expect(b.elements()).toMatchObject([{ kind: 'text', role: 'title' }])
  })
})

describe('links', () => {
  it('links a box to a workspace file', () => {
    const b = boardWith({ box: 'auth', at: [0, 0], label: 'Auth' })
    b.apply(cmd({ link: 'auth', to: 'architecture/auth.md' }))
    expect(b.named('auth')).toMatchObject({ link: 'architecture/auth.md' })
    expect(b.describe()).toContain('links to architecture/auth.md')
  })
})

describe('describe', () => {
  it('summarises the board in grid terms', () => {
    const b = boardWith(
      { page: 'Web' },
      { box: 'browser', at: [0, 1], label: 'Browser', color: 'violet' },
      { box: 'db', at: [2, 1], label: 'Database', shape: 'ellipse', color: 'green' },
      { arrow: ['browser', 'db'], label: 'SQL' },
      { note: 'Retries', at: [3, 2] },
      { page: 'Ops' },
      { box: 'ci', at: [0, 0], label: 'CI' },
      { page: 'Web' }
    )
    expect(b.describe()).toBe(
      [
        'pages: "Web" (current), "Ops"',
        'title "Web"',
        'box browser "Browser" at [0,1] violet',
        'box db "Database" at [2,1] green ellipse',
        'arrow browser->db "SQL"',
        'note "Retries" at [3,2]',
        'on page "Ops" (not current): ci "CI"'
      ].join('\n')
    )
  })

  it('describes every page in words for the builder', () => {
    const b = boardWith(
      { page: 'Data' },
      { option: 'pg', at: [0, 1], label: 'Postgres' },
      { option: 'fb', at: [1, 1], label: 'Firebase' },
      { pick: 'fb' },
      { box: 'api', at: [0, 0], label: 'API', link: 'architecture/api.md' },
      { arrow: ['api', 'fb'], label: 'writes' }
    )
    expect(b.describePages()).toBe(
      [
        'Page "Data":',
        '- Postgres (rejected option)',
        '- Firebase (chosen)',
        '- API [architecture/api.md]',
        '- API → Firebase (writes)'
      ].join('\n')
    )
  })

  it('round-trips through JSON and survives garbage', () => {
    const b = boardWith({ page: 'X' }, { box: 'a', at: [0, 0], label: 'A' })
    const again = BoardModel.fromJSON(JSON.parse(JSON.stringify(b.toJSON())))
    expect(again.describe()).toBe(b.describe())
    expect(BoardModel.fromJSON({ version: 2 }).isBlank).toBe(true)
    expect(BoardModel.fromJSON(null).isBlank).toBe(true)
  })
})

describe('screenshots and circles', () => {
  const image = (file = 'shot-1.jpg'): ShotImage => ({
    file,
    width: 1200,
    height: 800,
    marks: [
      { text: 'Sign up', x: 0.5, y: 0.25, w: 0.1, h: 0.05 },
      { text: 'Pricing plans', x: 0.1, y: 0.6, w: 0.3, h: 0.1 }
    ]
  })
  const shot = (
    b: BoardModel,
    name = 'landing',
    at: [number, number] = [0, 1],
    file?: string
  ): Effect[] => b.apply({ op: 'shot', name, at, label: 'Landing page', image: image(file) })
  const shots = (b: BoardModel): ShotEl[] =>
    b.elements().filter((e): e is ShotEl => e.kind === 'shot')

  it('places a screenshot up to two cells each way, keeping its shape, clear of boxes', () => {
    const b = boardWith({ box: 'api', at: [0, 1] })
    const fx = shot(b)
    expect(fx.map((f) => f.fx)).toEqual(['add'])
    const [s] = shots(b)
    // As big as two cells each way allows, keeping the picture's 3:2 shape.
    expect(s.h).toBe(GRID.row + GRID.h)
    expect(s.w).toBeLessThanOrEqual(GRID.col + GRID.w)
    expect(s.w / s.h).toBeCloseTo(1.5, 1)
    const api = boundsOf(boxes(b)[0])!
    const pic = boundsOf(s)!
    const overlap =
      api.x < pic.x + pic.w &&
      api.x + api.w > pic.x &&
      api.y < pic.y + pic.h &&
      api.y + api.h > pic.y
    expect(overlap).toBe(false)
    // A box drawn afterwards keeps out of it too.
    b.apply(cmd({ box: 'web', at: [s.x / GRID.col, s.y / GRID.row] }))
    const web = boundsOf(boxes(b).find((x) => x.name === 'web')!)!
    expect(web.x >= pic.x + pic.w || web.y >= pic.y + pic.h || web.x + web.w <= pic.x).toBe(true)
  })

  it('needs a picture, and retaking one swaps it in place', () => {
    const b = new BoardModel()
    expect(b.apply(cmd({ shot: 'landing', at: [0, 0] }))).toEqual([])
    shot(b)
    const before = shots(b)[0]
    const fx = shot(b, 'landing', [3, 3], 'shot-2.jpg')
    expect(fx).toMatchObject([{ fx: 'update' }])
    const after = shots(b)[0]
    expect(shots(b)).toHaveLength(1)
    expect([after.x, after.y, after.rev, after.image.file]).toEqual([
      before.x,
      before.y,
      2,
      'shot-2.jpg'
    ])
  })

  it('arrows join screenshots, and the board describes them with their parts', () => {
    const b = boardWith({ box: 'api', at: [3, 1] })
    shot(b)
    expect(b.apply(cmd({ arrow: ['landing', 'api'], label: 'calls' }))).toMatchObject([
      { fx: 'add' }
    ])
    expect(b.describe()).toContain('shot landing "Landing page"')
    expect(b.describe()).toContain('covering 2x2 cells')
    expect(b.describe()).toContain('"Sign up"')
    expect(b.describePages()).toContain('Screenshot of the running app: Landing page')
  })

  it('stops at the screenshot limit', () => {
    const b = new BoardModel()
    for (let i = 0; i < MAX_SHOTS; i++) shot(b, `s${i}`, [0, i])
    expect(shot(b, 'one-more')).toEqual([])
  })

  it('circles a shape for a moment without adding anything', () => {
    const b = boardWith({ box: 'api', at: [1, 1] })
    const count = b.elements().length
    const [fx] = b.apply(cmd({ circle: 'api' }))
    const api = boxes(b)[0]
    expect(fx).toEqual({
      fx: 'circle',
      page: b.currentPage.id,
      bounds: { x: api.x, y: api.y, w: api.w, h: api.h },
      ms: 2400
    })
    expect(b.elements()).toHaveLength(count)
    expect(b.apply(cmd({ circle: 'nothing' }))).toEqual([])
  })

  it('circles one element of a screenshot by its text', () => {
    const b = new BoardModel()
    shot(b)
    const s = shots(b)[0]
    const [fx] = b.apply(cmd({ circle: 'landing', on: 'sign up' }))
    expect(fx).toMatchObject({
      fx: 'circle',
      bounds: { x: s.x + 0.5 * s.w, y: s.y + 0.25 * s.h, w: 0.1 * s.w, h: 0.05 * s.h }
    })
    // A close match counts; something that isn't on the picture rings nothing.
    expect(b.apply(cmd({ circle: 'landing', on: 'pricing' }))).toHaveLength(1)
    expect(b.apply(cmd({ circle: 'landing', on: 'Checkout' }))).toEqual([])
    // "on" only means something for a screenshot.
    b.apply(cmd({ box: 'api', at: [4, 0] }))
    expect(b.apply(cmd({ circle: 'api', on: 'Sign up' }))).toEqual([])
  })
})
