// A VS Code-styled replacement for @codemirror/search's built-in panel: one
// compact row — find input (with the match-case / whole-word / regex
// toggles inline inside it, VS Code-style, instead of CodeMirror's stock
// panel spelling them out as separate checkboxes), match count, prev/next,
// close.
//
// No replace UI, so no expand chevron either — CodeView is a read-only
// source viewer (see CLAUDE.md:
// "Don't add an in-app diagram editor... Authoring happens in the user's
// editor"). CodeMirror's replace commands would still work in-memory since
// `editable.of(false)` doesn't set `state.readOnly`, but wiring them up would
// silently discard "edits" instead of ever writing them to disk — misleading
// rather than merely unsupported.
import { EditorView, Panel, ViewUpdate } from '@codemirror/view'
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  setSearchQuery
} from '@codemirror/search'

// Counts total matches and the 1-based index of the one the current
// selection sits on, so the panel can show "3 of 12" like VS Code. Capped —
// a huge file with a one-character query shouldn't walk the whole document
// on every keystroke.
const MAX_COUNTED_MATCHES = 2000

function countMatches(view: EditorView, query: SearchQuery): { total: number; current: number } {
  if (!query.valid) return { total: 0, current: 0 }
  const sel = view.state.selection.main
  const cursor = query.getCursor(view.state)
  let total = 0
  let current = 0
  let m = cursor.next()
  while (!m.done && total < MAX_COUNTED_MATCHES) {
    total++
    if (m.value.from === sel.from && m.value.to === sel.to) current = total
    m = cursor.next()
  }
  return { total, current }
}

function iconButton(label: string, title: string, className: string): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = className
  btn.title = title
  btn.setAttribute('aria-label', title)
  btn.textContent = label
  return btn
}

export function createVSCodeSearchPanel(view: EditorView): Panel {
  const dom = document.createElement('div')
  dom.className = 'cm-vsc-search'

  const findRow = document.createElement('div')
  findRow.className = 'cm-vsc-row'

  const inputWrap = document.createElement('div')
  inputWrap.className = 'cm-vsc-input-wrap'

  const searchInput = document.createElement('input')
  searchInput.type = 'text'
  searchInput.placeholder = 'Find'
  searchInput.className = 'cm-vsc-input'
  searchInput.setAttribute('main-field', 'true')
  searchInput.spellcheck = false

  const caseBtn = iconButton('Aa', 'Match case', 'cm-vsc-option-btn')
  const wordBtn = iconButton('ab', 'Match whole word', 'cm-vsc-option-btn')
  const regexBtn = iconButton('.*', 'Use regular expression', 'cm-vsc-option-btn')

  const inputOptions = document.createElement('div')
  inputOptions.className = 'cm-vsc-input-options'
  inputOptions.append(caseBtn, wordBtn, regexBtn)

  inputWrap.append(searchInput, inputOptions)

  const countLabel = document.createElement('span')
  countLabel.className = 'cm-vsc-count'

  const prevBtn = iconButton('↑', 'Previous match (Shift+Enter)', 'cm-vsc-icon-btn')
  const nextBtn = iconButton('↓', 'Next match (Enter)', 'cm-vsc-icon-btn')
  const closeBtn = iconButton('✕', 'Close (Esc)', 'cm-vsc-icon-btn cm-vsc-close')

  findRow.append(inputWrap, countLabel, prevBtn, nextBtn, closeBtn)
  dom.append(findRow)

  const currentQuery = (): SearchQuery => getSearchQuery(view.state)

  const dispatchQuery = (
    patch: Partial<{ search: string; caseSensitive: boolean; wholeWord: boolean; regexp: boolean }>
  ): void => {
    const q = currentQuery()
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search: patch.search ?? q.search,
          caseSensitive: patch.caseSensitive ?? q.caseSensitive,
          wholeWord: patch.wholeWord ?? q.wholeWord,
          regexp: patch.regexp ?? q.regexp
        })
      )
    })
  }

  const refresh = (): void => {
    const q = currentQuery()
    if (document.activeElement !== searchInput && searchInput.value !== q.search) {
      searchInput.value = q.search
    }
    caseBtn.classList.toggle('is-active', q.caseSensitive)
    wordBtn.classList.toggle('is-active', q.wholeWord)
    regexBtn.classList.toggle('is-active', q.regexp)
    if (!q.search) {
      countLabel.textContent = ''
    } else if (!q.valid) {
      countLabel.textContent = 'invalid'
    } else {
      const { total, current } = countMatches(view, q)
      countLabel.textContent = total === 0 ? 'No results' : `${current || 1} of ${total}`
    }
  }

  searchInput.addEventListener('input', () => dispatchQuery({ search: searchInput.value }))
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) findPrevious(view)
      else findNext(view)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeSearchPanel(view)
    }
  })
  caseBtn.addEventListener('click', () =>
    dispatchQuery({ caseSensitive: !currentQuery().caseSensitive })
  )
  wordBtn.addEventListener('click', () => dispatchQuery({ wholeWord: !currentQuery().wholeWord }))
  regexBtn.addEventListener('click', () => dispatchQuery({ regexp: !currentQuery().regexp }))
  prevBtn.addEventListener('click', () => findPrevious(view))
  nextBtn.addEventListener('click', () => findNext(view))
  closeBtn.addEventListener('click', () => closeSearchPanel(view))

  return {
    dom,
    top: true,
    mount() {
      refresh()
      searchInput.focus()
      searchInput.select()
    },
    update(update: ViewUpdate) {
      const queryChanged = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(setSearchQuery))
      )
      if (update.docChanged || update.selectionSet || queryChanged) refresh()
    }
  }
}
