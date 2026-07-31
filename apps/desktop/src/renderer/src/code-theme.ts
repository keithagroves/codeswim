import type { Extension } from '@codemirror/state'
import { HighlightStyle } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

// Matches the app's theme tokens (assets/main.css :root) via CSS custom
// properties rather than CodeMirror's stock defaultHighlightStyle, which is
// light-oriented and read as off-palette (mismatched hues, poor contrast)
// against --bg. Using var(...) here — not copied hex — keeps this in sync
// if the tokens ever change.
// A factory (rather than one fixed instance) so callers can match whichever
// surface the editor sits on: the full-page CodeView sits on --bg, while
// CodeSnippetCard sits on the card's --bg-raised and would otherwise show a
// seam between its own background and the editor's.
export function createCodeEditorTheme(background = 'var(--bg)'): Extension {
  return EditorView.theme(
    {
      '&': {
        color: 'var(--text)',
        backgroundColor: background
      },
      '.cm-content': {
        caretColor: 'var(--accent)'
      },
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: 'var(--accent)'
      },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: 'var(--accent-tint)'
      },
      '.cm-activeLine': {
        backgroundColor: 'rgba(255, 255, 255, 0.04)'
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'rgba(255, 255, 255, 0.04)'
      },
      '.cm-gutters': {
        backgroundColor: 'var(--bg-raised)',
        color: 'var(--text-muted)',
        border: 'none',
        borderRight: '1px solid var(--border)'
      },
      '.cm-lineNumbers .cm-gutterElement': {
        color: 'var(--text-muted)'
      },
      '.cm-matchingBracket, .cm-nonmatchingBracket': {
        backgroundColor: 'var(--accent-tint)',
        outline: 'none'
      }
    },
    { dark: true }
  )
}

export const codeHighlightStyle = HighlightStyle.define([
  {
    tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword],
    color: 'var(--pastel-periwinkle)'
  },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--pastel-mint)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--pastel-peach)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--pastel-lavender)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--accent)' },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: 'var(--text)' },
  { tag: [t.propertyName, t.variableName, t.attributeName], color: 'var(--text)' },
  {
    tag: [t.comment, t.lineComment, t.blockComment],
    color: 'var(--text-muted)',
    fontStyle: 'italic'
  },
  { tag: [t.meta, t.annotation], color: 'var(--text-muted)' },
  { tag: [t.punctuation, t.bracket, t.paren, t.brace], color: 'var(--text-muted)' },
  { tag: t.operator, color: 'var(--pastel-periwinkle)' },
  { tag: t.invalid, color: 'var(--error-text)' },
  { tag: t.link, color: 'var(--accent)', textDecoration: 'underline' },
  { tag: t.heading, color: 'var(--text)', fontWeight: 'bold' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' }
])
