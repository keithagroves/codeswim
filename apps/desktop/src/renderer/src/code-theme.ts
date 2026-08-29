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
      },
      // Highlighting for matches found via Ctrl/Cmd+F (see search-panel.ts
      // for the panel UI itself, styled separately below).
      '.cm-searchMatch': {
        backgroundColor: 'var(--accent-tint)'
      },
      '.cm-searchMatch-selected': {
        backgroundColor: 'var(--accent)',
        color: 'var(--bg)'
      },
      // CodeMirror-managed wrapper around whatever createPanel returns.
      '.cm-panels': {
        backgroundColor: 'var(--bg-raised)',
        color: 'var(--text)'
      },
      // Custom VS Code-style find panel (code-search-panel.ts). Sized up
      // from CodeMirror's stock panel, which reads as cramped/too-small at
      // the app's normal UI scale.
      '.cm-vsc-search': {
        borderBottom: '1px solid var(--border)'
      },
      '.cm-vsc-row': {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '6px 10px'
      },
      '.cm-vsc-input-wrap': {
        position: 'relative',
        flex: '1',
        minWidth: '0'
      },
      '.cm-vsc-input': {
        width: '100%',
        boxSizing: 'border-box',
        height: '26px',
        // Right-padded so typed text never runs under the Aa/ab/.* buttons
        // pinned inside the field's right edge.
        padding: '0 82px 0 8px',
        fontSize: '13px',
        fontFamily: 'inherit',
        backgroundColor: 'var(--bg)',
        color: 'var(--text)',
        border: '1px solid var(--border)',
        borderRadius: '4px'
      },
      '.cm-vsc-input:focus': {
        outline: '1px solid var(--accent)',
        outlineOffset: '-1px'
      },
      // Match-case / whole-word / regex toggles, inline inside the input —
      // VS Code puts these here rather than as a separate options row.
      '.cm-vsc-input-options': {
        position: 'absolute',
        top: '2px',
        bottom: '2px',
        right: '3px',
        display: 'flex',
        alignItems: 'stretch',
        gap: '2px'
      },
      '.cm-vsc-count': {
        flexShrink: '0',
        minWidth: '64px',
        fontSize: '12px',
        color: 'var(--text-muted)',
        textAlign: 'center'
      },
      '.cm-vsc-icon-btn': {
        flexShrink: '0',
        height: '26px',
        minWidth: '26px',
        padding: '0 6px',
        fontSize: '12.5px',
        backgroundColor: 'var(--bg-muted)',
        color: 'var(--text)',
        border: '1px solid var(--border)',
        borderRadius: '4px',
        cursor: 'pointer'
      },
      '.cm-vsc-icon-btn:hover': {
        backgroundColor: 'var(--bg-raised)'
      },
      '.cm-vsc-option-btn': {
        flexShrink: '0',
        padding: '0 5px',
        fontSize: '11.5px',
        background: 'none',
        color: 'var(--text-muted)',
        border: '1px solid transparent',
        borderRadius: '3px',
        cursor: 'pointer'
      },
      '.cm-vsc-option-btn:hover': {
        backgroundColor: 'var(--bg-muted)',
        color: 'var(--text)'
      },
      '.cm-vsc-option-btn.is-active': {
        backgroundColor: 'var(--accent-tint)',
        borderColor: 'var(--accent)',
        color: 'var(--accent)'
      },
      '.cm-vsc-close': {
        color: 'var(--text-muted)'
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
