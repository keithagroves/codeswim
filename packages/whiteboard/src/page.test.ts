import { describe, expect, it } from 'vitest'
import { asksForChange } from './guards'
import { formatCheckpoint } from './checkpoint'
import {
  canShow,
  diffPages,
  formatPage,
  isPageCmd,
  looksLikeServer,
  shotMarks,
  toPageCmd,
  type PageSnapshot
} from './page'

const button = (
  text: string,
  width: number,
  style: Record<string, string> = {}
): PageSnapshot['elements'][number] => ({
  role: 'button',
  text,
  box: { width, height: 44 },
  style: { fontSize: '16px', backgroundColor: 'rgb(37, 99, 235)', ...style }
})

const landing = (width: number, extra: PageSnapshot['elements'] = []): PageSnapshot => ({
  url: 'http://localhost:5173/',
  title: 'Acme',
  elements: [
    { role: 'heading', text: 'Ship faster', box: { width: 600, height: 48 } },
    button('Sign up', width),
    button('Sign up', width),
    { role: 'link', text: 'Pricing', box: { width: 50, height: 18 } },
    ...extra
  ],
  text: 'Ship faster. Sign up. Pricing.'
})

describe('page lines', () => {
  it('parse point and show, and tell them apart from board commands', () => {
    expect(toPageCmd({ point: '  <b>Sign up</b> ' })).toEqual({
      op: 'point',
      target: 'Sign up',
      all: false
    })
    expect(toPageCmd({ point: 'button', all: true })).toEqual({
      op: 'point',
      target: 'button',
      all: true
    })
    expect(toPageCmd({ show: 'http://localhost:5173/pricing' })).toEqual({
      op: 'show',
      url: 'http://localhost:5173/pricing'
    })
    expect(toPageCmd({ point: '' })).toBeNull()
    expect(toPageCmd({ box: 'api' })).toBeNull()
    expect(isPageCmd({ op: 'point', target: 'x', all: false })).toBe(true)
    expect(isPageCmd({ op: 'clear' })).toBe(false)
  })
})

describe('canShow', () => {
  it('opens the local app or more of the site already showing, nothing else', () => {
    expect(canShow('http://localhost:5173/pricing', null)).toBe(true)
    expect(canShow('http://127.0.0.1:3000/', null)).toBe(true)
    expect(canShow('https://acme.dev/docs', 'https://acme.dev/')).toBe(true)
    expect(canShow('https://evil.example/', 'https://acme.dev/')).toBe(false)
    expect(canShow('https://acme.dev/', null)).toBe(false)
    expect(canShow('javascript:alert(1)', 'http://localhost:5173/')).toBe(false)
    expect(canShow('not a url', null)).toBe(false)
  })
})

describe('formatPage', () => {
  it('lists elements with sizes for the things whose size matters', () => {
    const text = formatPage(landing(220))
    expect(text).toContain('url: http://localhost:5173/')
    expect(text).toContain('- button "Sign up" 220×44')
    expect(text).toContain('- heading "Ship faster"\n')
    expect(text).toContain('- link "Pricing"')
    expect(text).toContain('Visible text: Ship faster.')
  })

  it('with no page open, says where the app runs or how to start it', () => {
    expect(formatPage(null, { devUrls: ['http://localhost:5173/'] })).toContain(
      '{"show":"http://localhost:5173/"}'
    )
    expect(formatPage(null, { servers: ['dev', 'storybook'] })).toContain(
      '{"start":"dev"} or {"start":"storybook"}'
    )
    expect(formatPage(null, { running: 'dev' })).toContain(`"dev" is running but hasn't printed`)
    expect(formatPage(null)).toContain('globe button')
  })
})

describe('looksLikeServer', () => {
  it('lets the narrator start dev servers, never builds, tests or deploys', () => {
    const run = (name: string, command = ''): boolean => looksLikeServer({ name, command })
    for (const yes of ['dev', 'start', 'serve', 'preview', 'dev:web', 'storybook', 'web']) {
      expect(run(yes), yes).toBe(true)
    }
    expect(run('play', 'vite --port 3000')).toBe(true)
    expect(run('api', 'uvicorn app:main --reload')).toBe(true)
    for (const no of ['build', 'test', 'deploy', 'dev:test', 'lint', 'release', 'clean']) {
      expect(run(no, 'vite build'), no).toBe(false)
    }
    expect(run('typecheck', 'tsc --noEmit')).toBe(false)
  })

  it('parses a start line', () => {
    expect(toPageCmd({ start: ' dev ' })).toEqual({ op: 'start', name: 'dev' })
    expect(toPageCmd({ start: '' })).toBeNull()
    expect(isPageCmd({ op: 'start', name: 'dev' })).toBe(true)
  })
})

describe('diffPages', () => {
  it('reports measured size and style changes, folding identical elements together', () => {
    const changes = diffPages(landing(220), landing(280, []))
    expect(changes).toEqual(['button "Sign up" (all 2): size 220×44 → 280×44 px'])
  })

  it('reports style changes, new and removed elements, and a different page', () => {
    const before = landing(220)
    const after: PageSnapshot = {
      ...landing(220, [button('Get started', 200)]),
      url: 'http://localhost:5173/home'
    }
    after.elements = after.elements.filter((e) => e.text !== 'Pricing')
    after.elements[1] = button('Sign up', 220, { backgroundColor: 'rgb(22, 163, 74)' })
    expect(diffPages(before, after)).toEqual([
      'The page is now http://localhost:5173/home (was http://localhost:5173/).',
      'button "Sign up": background rgb(37, 99, 235) → rgb(22, 163, 74)',
      'New: button "Get started"',
      'Gone: link "Pricing"'
    ])
  })

  it('is empty when nothing visible changed, which the checkpoint says plainly', () => {
    expect(diffPages(landing(220), landing(220))).toEqual([])
    const text = formatCheckpoint({
      brief: 'Widen the buttons.',
      diagrams: [],
      files: [],
      finalMessage: '',
      page: { url: 'http://localhost:5173/', changes: [] }
    })
    expect(text).toContain('nothing on it changed visibly')
    expect(
      formatCheckpoint({
        brief: 'b',
        diagrams: [],
        files: [],
        finalMessage: '',
        page: {
          url: 'http://localhost:5173/',
          changes: ['button "Sign up": size 220×44 → 280×44 px']
        }
      })
    ).toContain('Measured changes:\n- button "Sign up": size 220×44 → 280×44 px')
  })
})

describe('asksForChange', () => {
  it('hears instructions, not questions about options', () => {
    for (const yes of [
      'make them even wider',
      'actually, make them even wider',
      "Let's make them even wider",
      'can you move the button up?',
      'ok, use blue instead',
      'Please center the heading'
    ]) {
      expect(asksForChange(yes), yes).toBe(true)
    }
    for (const no of [
      'what if we made them wider?',
      'should we make them wider?',
      'why are they so wide?',
      'wait, make it red',
      'looks great'
    ]) {
      expect(asksForChange(no), no).toBe(false)
    }
  })
})

describe('shotMarks', () => {
  it('places what is on screen as fractions of the picture, leaving out what is scrolled away', () => {
    const marks = shotMarks({
      viewport: { width: 1000, height: 500, scrollY: 100 },
      elements: [
        { text: 'Sign up', box: { x: 500, y: 200, width: 100, height: 50 } },
        { text: 'Above the fold', box: { x: 0, y: 0, width: 100, height: 50 } },
        { text: 'Far below', box: { x: 0, y: 2000, width: 100, height: 50 } },
        { text: 'Cut by the edge', box: { x: 900, y: 550, width: 200, height: 100 } },
        { text: '', box: { x: 10, y: 150, width: 10, height: 10 } }
      ]
    })
    expect(marks).toEqual([
      { text: 'Sign up', x: 0.5, y: 0.2, w: 0.1, h: 0.1 },
      { text: 'Cut by the edge', x: 0.9, y: 0.9, w: 0.1, h: 0.1 }
    ])
  })

  it('keeps to the top of a tall view that was cut short', () => {
    const page = {
      viewport: { width: 500, height: 1000, scrollY: 0 },
      elements: [
        { text: 'Sign up', box: { x: 100, y: 150, width: 100, height: 50 } },
        { text: 'Footer', box: { x: 0, y: 900, width: 500, height: 50 } }
      ]
    }
    expect(shotMarks(page, 0.375)).toEqual([{ text: 'Sign up', x: 0.2, y: 0.4, w: 0.2, h: 0.133 }])
  })
})
