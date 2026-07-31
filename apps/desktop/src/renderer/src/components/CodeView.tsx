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
import { bracketMatching, syntaxHighlighting } from '@codemirror/language'
import { languageFor } from '../code-lang'
import { createCodeEditorTheme, codeHighlightStyle } from '../code-theme'
import type { LineRange } from '../path-utils'

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
      syntaxHighlighting(codeHighlightStyle, { fallback: true }),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.editable.of(false),
      highlightField,
      createCodeEditorTheme(),
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
