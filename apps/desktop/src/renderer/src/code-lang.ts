import type { Extension } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { extname } from './path-utils'

export function languageFor(path: string): Extension | null {
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
