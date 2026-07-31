import { useEffect, useRef } from 'react'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import { syntaxHighlighting } from '@codemirror/language'
import { languageFor } from '../code-lang'
import { createCodeEditorTheme, codeHighlightStyle } from '../code-theme'
import type { LineRange } from '../path-utils'

function sliceLines(text: string, range: LineRange): string {
  const lines = text.split(/\r\n?|\n/)
  const start = Math.max(1, Math.min(range.start, lines.length))
  const end = Math.max(start, Math.min(range.end, lines.length))
  return lines.slice(start - 1, end).join('\n')
}

export function CodeSnippetCard({
  path,
  range,
  fileText,
  onOpenEditor
}: {
  path: string
  range: LineRange
  fileText: string
  onOpenEditor: () => void
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!hostRef.current) return
    const snippet = sliceLines(fileText, range)
    const lang = languageFor(path)
    const extensions: Extension[] = [
      // Real file line numbers, not 1-based local ones — this is what makes
      // the card read as "a piece of the actual file" rather than a
      // disconnected fragment.
      lineNumbers({ formatNumber: (n) => String(n + range.start - 1) }),
      syntaxHighlighting(codeHighlightStyle, { fallback: true }),
      EditorView.editable.of(false),
      createCodeEditorTheme('var(--bg-raised)'),
      EditorView.theme({
        '&': { height: 'auto', fontSize: '13px' },
        '.cm-scroller': { overflow: 'visible' },
        '.cm-content, .cm-gutter': { minHeight: 'auto' }
      })
    ]
    if (lang) extensions.push(lang)

    const view = new EditorView({
      state: EditorState.create({ doc: snippet, extensions }),
      parent: hostRef.current
    })
    return () => view.destroy()
  }, [path, range, fileText])

  return (
    <div className="code-snippet-card">
      <div className="code-snippet-header">
        <span className="code-snippet-path">
          {path}:{range.start}
          {range.end !== range.start ? `–${range.end}` : ''}
        </span>
        <button type="button" className="link-btn code-snippet-open" onClick={onOpenEditor}>
          Open in editor →
        </button>
      </div>
      <div ref={hostRef} className="code-snippet-body" />
    </div>
  )
}
