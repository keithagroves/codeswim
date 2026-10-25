import { describe, expect, it } from 'vitest'
import { applyPronunciations, parsePronunciations } from './pronounce'

describe('parsePronunciations', () => {
  it('reads { words } or a flat object, dropping bad entries', () => {
    expect(parsePronunciations('{"words":{"codeswim":"code swim","x":42," ":"y"}}')).toEqual({
      codeswim: 'code swim'
    })
    expect(parsePronunciations('{"Kokoro":"/kˈOkəɹO/"}')).toEqual({ Kokoro: '/kˈOkəɹO/' })
  })

  it('treats a missing or broken file as empty', () => {
    expect(parsePronunciations(null)).toEqual({})
    expect(parsePronunciations('{nope')).toEqual({})
    expect(parsePronunciations('[1,2]')).toEqual({})
  })
})

describe('applyPronunciations', () => {
  const table = {
    codeswim: 'code swim',
    Kokoro: '/kˈOkəɹO/',
    'Open Code': 'open code',
    Code: 'kode'
  }

  it('respells whole words in any case', () => {
    expect(applyPronunciations('Codeswim draws it.', table)).toBe('code swim draws it.')
    expect(applyPronunciations('The codeswimmer stays.', table)).toBe('The codeswimmer stays.')
  })

  it('passes IPA to Kokoro inline, keeping the written word', () => {
    expect(applyPronunciations('Kokoro speaks.', table)).toBe('[Kokoro](/kˈOkəɹO/) speaks.')
  })

  it('prefers the longer entry', () => {
    expect(applyPronunciations('Run Open Code now.', table)).toBe('Run open code now.')
  })

  it('leaves text alone with no table', () => {
    expect(applyPronunciations('Nothing changes.', {})).toBe('Nothing changes.')
  })
})
