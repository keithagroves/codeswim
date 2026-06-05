import { describe, it, expect } from 'vitest'
import { parseAnsi } from './ansi'

const ESC = '\u001b'

describe('parseAnsi', () => {
  it('returns a single plain segment for unstyled text', () => {
    expect(parseAnsi('hello world')).toEqual([[{ text: 'hello world' }]])
  })

  it('applies a basic foreground colour and resets', () => {
    const out = parseAnsi(`${ESC}[31mred${ESC}[0m`)
    expect(out).toEqual([[{ text: 'red', fg: '#ff7b72' }]])
  })

  it('maps bright colours to the 8-15 palette range', () => {
    const out = parseAnsi(`${ESC}[91mx`)
    expect(out[0][0]).toMatchObject({ text: 'x', fg: '#ffa198' })
  })

  it('tracks bold/dim/italic/underline decorations', () => {
    const out = parseAnsi(`${ESC}[1m${ESC}[4mx`)
    expect(out[0][0]).toMatchObject({ text: 'x', bold: true, underline: true })
  })

  it('resolves 256-colour codes via the cube', () => {
    const out = parseAnsi(`${ESC}[38;5;196mx`)
    expect(out[0][0].fg).toBe('rgb(255, 0, 0)')
  })

  it('resolves truecolor codes', () => {
    const out = parseAnsi(`${ESC}[38;2;10;20;30mx`)
    expect(out[0][0].fg).toBe('rgb(10, 20, 30)')
  })

  it('drops non-SGR control sequences (erase, cursor)', () => {
    expect(parseAnsi(`${ESC}[2K${ESC}[1AX`)).toEqual([[{ text: 'X' }]])
  })

  it('splits on newlines into separate lines', () => {
    expect(parseAnsi('a\nb')).toEqual([[{ text: 'a' }], [{ text: 'b' }]])
  })

  it('treats CRLF as a single line break', () => {
    expect(parseAnsi('a\r\nb')).toEqual([[{ text: 'a' }], [{ text: 'b' }]])
  })

  it('rewrites the line on a bare carriage return (spinner frames)', () => {
    expect(parseAnsi('loading...\rdone')).toEqual([[{ text: 'done' }]])
  })

  it('carries style across the colour codes within a line', () => {
    const out = parseAnsi(`${ESC}[32mok${ESC}[39m done`)
    expect(out).toEqual([[{ text: 'ok', fg: '#3fb950' }, { text: ' done' }]])
  })
})
