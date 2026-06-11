import { useEffect, useRef } from 'react'
import { EditorState, Extension, StateEffect, StateField } from '@codemirror/state'
import {
  Decoration,
  DecorationSet,
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { bracketMatching, syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { extname } from '../path-utils'
import type { LineRange } from '../store'

function languageFor(path: string): Extension | null {
  switch (extname(path)) {
    case '.ts':
    case '.tsx':
      return javascript({ jsx: true, typescript: true })
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return javascript({ jsx: true })
    case '.py':
      return python()
    case '.html':
    case '.htm':
      return html()
    case '.css':
      return css()
    case '.json':
      return json()
    case '.md':
    case '.markdown':
      return markdown()
    default:
      return null
  }
}

// Dark syntax palette tuned to the app's monochrome theme — muted hues,
// no saturated rainbow.
const darkHighlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], color: '#c792ea' },
  { tag: [tags.string, tags.special(tags.string)], color: '#9ece8c' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: '#e5b567' },
  { tag: [tags.comment, tags.meta], color: '#6b6b76', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#82aaff' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: '#7fd6c2' },
  { tag: [tags.propertyName, tags.attributeName], color: '#a6b8e8' },
  { tag: [tags.definition(tags.variableName), tags.variableName], color: '#ececf1' },
  { tag: [tags.tagName], color: '#f47067' },
  { tag: [tags.heading], color: '#ececf1', fontWeight: 'bold' },
  { tag: [tags.link, tags.url], color: '#6e9bff' },
  { tag: [tags.punctuation, tags.bracket], color: '#94949f' }
])

const darkEditorTheme = EditorView.theme(
  {
    '&': { backgroundColor: '#0e0e11', color: '#ececf1' },
    '.cm-gutters': {
      backgroundColor: '#0e0e11',
      color: '#5a5a64',
      border: 'none',
      borderRight: '1px solid #26262c'
    },
    '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.035)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(255, 255, 255, 0.035)', color: '#94949f' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      backgroundColor: 'rgba(110, 155, 255, 0.2)'
    },
    '.cm-cursor': { borderLeftColor: '#ececf1' },
    '.cm-matchingBracket': {
      backgroundColor: 'rgba(110, 155, 255, 0.25)',
      outline: 'none'
    }
  },
  { dark: true }
)

// StateEffect carries a desired highlight range. StateField rebuilds a
// DecorationSet of `.cm-target-line` lines whenever it sees the effect.
const setHighlightRange = StateEffect.define<LineRange | null>()

const highlightDeco = Decoration.line({ class: 'cm-target-line' })

const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decos, tr) {
    let next = decos.map(tr.changes)
    for (const effect of tr.effects) {
      if (!effect.is(setHighlightRange)) continue
      const range = effect.value
      if (!range) {
        next = Decoration.none
        continue
      }
      const lastLine = tr.state.doc.lines
      const start = Math.max(1, Math.min(range.start, lastLine))
      const end = Math.max(start, Math.min(range.end, lastLine))
      const builder: Array<ReturnType<typeof highlightDeco.range>> = []
      for (let lineNo = start; lineNo <= end; lineNo++) {
        builder.push(highlightDeco.range(tr.state.doc.line(lineNo).from))
      }
      next = Decoration.set(builder)
    }
    return next
  },
  provide: (f) => EditorView.decorations.from(f)
})

export function CodeView({
  path,
  contents,
  highlightRange
}: {
  path: string
  contents: string
  highlightRange?: LineRange | null
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)

  useEffect(() => {
    if (!hostRef.current) return
    const lang = languageFor(path)
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      history(),
      bracketMatching(),
      syntaxHighlighting(darkHighlightStyle, { fallback: true }),
      darkEditorTheme,
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.editable.of(false),
      highlightField,
      EditorView.theme({
        '&': { height: '100%' },
        '.cm-scroller': { overflow: 'auto' }
      })
    ]
    if (lang) extensions.push(lang)

    const view = new EditorView({
      state: EditorState.create({ doc: contents, extensions }),
      parent: hostRef.current
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [path, contents])

  // Apply the highlight range (and scroll to it) whenever it changes — or
  // whenever the file content changes underneath us. The editor is recreated
  // on file change, so this effect runs after the new view exists.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const range = highlightRange ?? null
    const effects: StateEffect<unknown>[] = [setHighlightRange.of(range)]
    if (range) {
      const lastLine = view.state.doc.lines
      const start = Math.max(1, Math.min(range.start, lastLine))
      const pos = view.state.doc.line(start).from
      effects.push(EditorView.scrollIntoView(pos, { y: 'start', yMargin: 80 }))
    }
    view.dispatch({ effects })
  }, [highlightRange, contents])

  return <div ref={hostRef} className="code-view" />
}
