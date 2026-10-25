// Per-workspace pronunciations for the natural voice, from the hand-edited
// `.codeswim/pronunciations.json` (same tolerant-validation precedent as
// .codeswim/hooks.json and runs.json: a missing file or bad entry is skipped,
// never fatal).
//
//   { "words": { "codeswim": "code swim", "Kokoro": "/kˈOkəɹO/" } }
//
// A value is either a respelling, spoken as written, or IPA between slashes,
// passed to Kokoro inline as `[word](/ipa/)`. Product names are the usual
// reason: a voice model has never heard of most of them.

export const PRONUNCIATIONS_FILE = '.codeswim/pronunciations.json'

export type Pronunciations = Record<string, string>

const MAX_ENTRIES = 200

/** The table from the file's JSON text; anything malformed is dropped. */
export function parsePronunciations(raw: string | null): Pronunciations {
  if (!raw) return {}
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return {}
  }
  const words =
    data && typeof data === 'object' && 'words' in data ? (data as { words: unknown }).words : data
  if (!words || typeof words !== 'object' || Array.isArray(words)) return {}
  const out: Pronunciations = {}
  for (const [word, say] of Object.entries(words as Record<string, unknown>).slice(
    0,
    MAX_ENTRIES
  )) {
    const w = word.trim()
    if (!w || w.length > 60 || typeof say !== 'string' || !say.trim() || say.length > 120) continue
    out[w] = say.trim()
  }
  return out
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Apply the table to a sentence before it's spoken. Whole words, any case. */
export function applyPronunciations(text: string, table: Pronunciations): string {
  // Longer entries first, so "Open Code" wins over "Code".
  const words = Object.keys(table).sort((a, b) => b.length - a.length)
  if (!words.length) return text
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}_])(${words.map(escape).join('|')})(?![\\p{L}\\p{N}_])`,
    'giu'
  )
  const lookup = new Map(words.map((w) => [w.toLowerCase(), table[w]]))
  return text.replace(re, (match) => {
    const say = lookup.get(match.toLowerCase())
    if (!say) return match
    const ipa = /^\/(.+)\/$/.exec(say)
    return ipa ? `[${match}](/${ipa[1]}/)` : say
  })
}
