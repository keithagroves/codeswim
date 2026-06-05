import { describe, it, expect } from 'vitest'
import {
  parseCommitMessage,
  composeCommitBody,
  buildTrailers,
  buildCommitSynthesisPrompt
} from './synthesize'

describe('parseCommitMessage', () => {
  it('extracts subject and body from <commit> markers', () => {
    const raw = `Sure, here is the message:\n<commit>\nAdd refund guard\n\nMake the refund path idempotent.\n</commit>\nHope that helps!`
    expect(parseCommitMessage(raw)).toEqual({
      subject: 'Add refund guard',
      body: 'Make the refund path idempotent.'
    })
  })

  it('falls back to a wrapping code fence when no markers', () => {
    const raw = '```\nFix watcher debounce\n\nDebounce tree-changed at 200ms.\n```'
    expect(parseCommitMessage(raw)).toEqual({
      subject: 'Fix watcher debounce',
      body: 'Debounce tree-changed at 200ms.'
    })
  })

  it('falls back to raw text with first non-empty line as subject', () => {
    const raw = '\n\nUpdate docs\n\nClarify the IPC contract.'
    expect(parseCommitMessage(raw)).toEqual({
      subject: 'Update docs',
      body: 'Clarify the IPC contract.'
    })
  })

  it('strips a trailing period from the subject', () => {
    expect(parseCommitMessage('Tidy the parser.').subject).toBe('Tidy the parser')
  })

  it('returns empty body when there is only a subject', () => {
    expect(parseCommitMessage('<commit>\nJust a subject\n</commit>')).toEqual({
      subject: 'Just a subject',
      body: ''
    })
  })

  it('returns empty subject and body for blank input', () => {
    expect(parseCommitMessage('   \n  ')).toEqual({ subject: '', body: '' })
  })
})

describe('buildTrailers', () => {
  it('marks synthesized true and reports coverage', () => {
    expect(buildTrailers({ coveragePassed: true })).toBe(
      'Codeswim-Synthesized: true\nCodeswim-Coverage: pass'
    )
    expect(buildTrailers({ coveragePassed: false })).toContain('Codeswim-Coverage: unknown')
  })
})

describe('composeCommitBody', () => {
  it('appends trailers after the spec with a blank line', () => {
    const out = composeCommitBody('Some spec body.', { coveragePassed: true })
    expect(out).toBe('Some spec body.\n\nCodeswim-Synthesized: true\nCodeswim-Coverage: pass')
  })

  it('emits trailers alone when the spec is empty', () => {
    expect(composeCommitBody('   ', { coveragePassed: true })).toBe(
      'Codeswim-Synthesized: true\nCodeswim-Coverage: pass'
    )
  })
})

describe('buildCommitSynthesisPrompt', () => {
  it('embeds the diff and a secret-scrub instruction', () => {
    const prompt = buildCommitSynthesisPrompt('diff --git a/x b/x')
    expect(prompt).toContain('diff --git a/x b/x')
    expect(prompt).toContain('SCRUB SECRETS')
  })

  it('truncates an oversized diff and notes it', () => {
    const huge = 'x'.repeat(70_000)
    const prompt = buildCommitSynthesisPrompt(huge)
    expect(prompt).toContain('diff truncated for length')
    expect(prompt.length).toBeLessThan(huge.length)
  })
})
