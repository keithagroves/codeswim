import { describe, expect, it } from 'vitest'
import {
  isTarget,
  isWebUrl,
  measureScript,
  normalizeBrowserUrl,
  outlineScript,
  pointScript,
  screenshotName,
  screenshotsToPrune,
  toMatches,
  toOutline
} from './browser-page'

describe('normalizeBrowserUrl', () => {
  const url = (s: string): string | undefined => {
    const r = normalizeBrowserUrl(s)
    return 'url' in r ? r.url : undefined
  }

  it('gives dev servers http and other hosts https', () => {
    expect(url('localhost:5173')).toBe('http://localhost:5173/')
    expect(url('127.0.0.1:3000/pricing')).toBe('http://127.0.0.1:3000/pricing')
    expect(url('localhost')).toBe('http://localhost/')
    expect(url('example.com')).toBe('https://example.com/')
    expect(url('example.com:8080/x')).toBe('http://example.com:8080/x')
    expect(url('  https://example.com/a?b=1  ')).toBe('https://example.com/a?b=1')
  })

  it('turns 0.0.0.0, which Chromium refuses, into localhost', () => {
    expect(url('http://0.0.0.0:4321/')).toBe('http://localhost:4321/')
    expect(url('0.0.0.0:4321')).toBe('http://localhost:4321/')
  })

  it('refuses anything but http(s)', () => {
    for (const bad of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,hi',
      'chrome://gpu'
    ]) {
      expect(normalizeBrowserUrl(bad)).toEqual({ error: 'Only http and https pages open here.' })
    }
    expect(normalizeBrowserUrl('   ')).toEqual({ error: 'Enter an address.' })
    expect(normalizeBrowserUrl('http://exa mple.com')).toHaveProperty('error')
  })
})

describe('isWebUrl', () => {
  it('lets the page navigate only to http(s)', () => {
    expect(isWebUrl('https://a.dev/')).toBe(true)
    expect(isWebUrl('http://localhost:1/')).toBe(true)
    expect(isWebUrl('file:///x')).toBe(false)
    expect(isWebUrl('mailto:a@b.c')).toBe(false)
    expect(isWebUrl('not a url')).toBe(false)
  })
})

describe('page scripts', () => {
  it('embed their arguments as JSON, so a target cannot break out of the string', () => {
    const evil = `"); alert(1); ("`
    expect(pointScript(evil, false)).toContain(
      `window.__codeswim.point(${JSON.stringify(evil)}, false, 2500`
    )
    expect(measureScript(['Sign up', evil])).toContain(JSON.stringify(['Sign up', evil]))
    expect(outlineScript()).toContain('"elements":80')
  })

  it('install the helper once per page', () => {
    expect(outlineScript()).toContain('if (window.__codeswim) return')
  })
})

describe('toOutline', () => {
  it('keeps well-formed elements and bounds everything', () => {
    const outline = toOutline({
      url: 'http://localhost:5173/',
      title: 'Acme',
      viewport: { width: 800, height: 600.4, scrollY: 0, pageHeight: 2000 },
      elements: [
        {
          ref: 'e1',
          role: 'button',
          text: 'Sign up',
          box: { x: 10.2, y: 20, width: 220, height: 44 },
          style: { fontSize: '16px', color: 'x'.repeat(100) }
        },
        { ref: 'nope', role: 'link', text: 'bad ref', box: {} },
        {
          ref: 'e2',
          role: 'link',
          text: 'Docs',
          box: { width: 'wide' },
          href: 'javascript:alert(1)'
        },
        'junk'
      ],
      text: 'y'.repeat(10_000),
      truncated: true
    })
    expect(outline.viewport.height).toBe(600)
    expect(outline.elements).toEqual([
      {
        ref: 'e1',
        role: 'button',
        text: 'Sign up',
        box: { x: 10, y: 20, width: 220, height: 44 },
        style: { fontSize: '16px' }
      },
      { ref: 'e2', role: 'link', text: 'Docs', box: { x: 0, y: 0, width: 0, height: 0 } }
    ])
    expect(outline.text).toHaveLength(3000)
    expect(outline.truncated).toBe(true)
  })

  it('survives garbage', () => {
    expect(toOutline(null).elements).toEqual([])
    expect(toOutline('x').url).toBe('')
  })
})

describe('toMatches', () => {
  it('reports found and missing targets', () => {
    expect(
      toMatches([
        {
          target: 'Sign up',
          found: true,
          element: { ref: 'e3', role: 'button', text: 'Sign up', box: {} }
        },
        { target: 'Nope', found: false },
        { target: 'Broken', found: true, element: null }
      ])
    ).toEqual([
      {
        target: 'Sign up',
        found: true,
        element: {
          ref: 'e3',
          role: 'button',
          text: 'Sign up',
          box: { x: 0, y: 0, width: 0, height: 0 }
        }
      },
      { target: 'Nope', found: false },
      { target: 'Broken', found: false }
    ])
    expect(toMatches(undefined)).toEqual([])
  })
})

describe('isTarget', () => {
  it('accepts short non-empty strings', () => {
    expect(isTarget('Sign up')).toBe(true)
    expect(isTarget('  ')).toBe(false)
    expect(isTarget(3)).toBe(false)
    expect(isTarget('x'.repeat(201))).toBe(false)
  })
})

describe('screenshots', () => {
  it('are named so they sort by time, and only the newest are kept', () => {
    expect(screenshotName(new Date('2026-10-20T09:08:07.123Z'))).toBe(
      'screenshot-2026-10-20T09-08-07-123Z.png'
    )
    const files = [
      '.gitignore',
      'notes.txt',
      'screenshot-3.png',
      'screenshot-1.png',
      'screenshot-2.png'
    ]
    expect(screenshotsToPrune(files, 2)).toEqual(['screenshot-1.png'])
    expect(screenshotsToPrune(files, 5)).toEqual([])
  })
})
