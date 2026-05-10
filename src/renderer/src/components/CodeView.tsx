import { useEffect, useRef } from 'react'
import { EditorState, Extension } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { bracketMatching, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { extname } from '../path-utils'

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

export function CodeView({
  path,
  contents
}: {
  path: string
  contents: string
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
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.editable.of(false),
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

  return <div ref={hostRef} className="code-view" />
}
