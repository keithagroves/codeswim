// Files the person names, read before the narrator answers.
//
// "What does auth.ts do?" shouldn't need the narrator to call a tool (each
// tool call is another multi-second round trip on a model that doesn't
// stream). Instead the app spots workspace paths in the question, reads them,
// and puts them in a <files> block, so the answer comes from the real code at
// the usual speed. Anything that needs digging goes to the read-only agent
// (a research line) instead.

/** How much of the workspace a question can pull in. */
export const FILE_LIMITS = { files: 3, perFile: 6000, total: 15000, folderEntries: 40 } as const

export interface Mentions {
  /** Workspace-relative file paths to read, best match first. */
  files: string[]
  /** Folders named in the question, with the files under them. */
  folders: { path: string; entries: string[] }[]
}

const TOKEN = /[\w@$.\-/]+/g

/**
 * Workspace files and folders a question names: an exact path
 * ("src/auth/session.ts"), a file name ("session.ts"), or a folder
 * ("src/auth" or "src/auth/"). A bare word without a dot or slash isn't a
 * path, so "auth" alone doesn't pull anything in.
 */
export function mentionedPaths(question: string, paths: readonly string[]): Mentions {
  const files: string[] = []
  const folders: Mentions['folders'] = []
  const lowerPaths = paths.map((p) => p.toLowerCase())
  const add = (p: string): void => {
    if (!files.includes(p) && files.length < FILE_LIMITS.files) files.push(p)
  }
  for (const raw of question.match(TOKEN) ?? []) {
    const token = raw.replace(/^[./]+(?=\w)/, '').replace(/[.,;:!?)]+$/, '')
    if (!token || (!token.includes('/') && !/\.\w{1,8}$/.test(token))) continue
    const t = token.toLowerCase().replace(/\/+$/, '')
    const exact = lowerPaths.indexOf(t)
    if (exact >= 0) {
      add(paths[exact])
      continue
    }
    if (!t.includes('/')) {
      // A file name: every file with that name, shortest path first.
      const named = paths
        .filter((_, i) => lowerPaths[i] === t || lowerPaths[i].endsWith(`/${t}`))
        .sort((a, b) => a.length - b.length)
      for (const p of named.slice(0, 2)) add(p)
      if (named.length) continue
    }
    const under = paths.filter((_, i) => lowerPaths[i].startsWith(`${t}/`))
    if (under.length && !folders.some((f) => f.path.toLowerCase() === t)) {
      const path = paths[lowerPaths.findIndex((p) => p.startsWith(`${t}/`))].slice(0, t.length)
      folders.push({ path, entries: under.slice(0, FILE_LIMITS.folderEntries) })
      continue
    }
    // A path ending in a file name that's elsewhere in the tree ("auth/session.ts").
    const tail = paths.filter((_, i) => lowerPaths[i].endsWith(`/${t}`))
    for (const p of tail.slice(0, 2)) add(p)
  }
  return { files, folders }
}

/** The <files> block: each file's text (cut to size) and each folder's listing. */
export function formatFiles(
  files: readonly { path: string; text: string }[],
  folders: Mentions['folders'] = []
): string {
  const out: string[] = []
  let budget: number = FILE_LIMITS.total
  for (const f of files) {
    if (budget <= 0) break
    const cap = Math.min(FILE_LIMITS.perFile, budget)
    const text =
      f.text.length > cap ? `${f.text.slice(0, cap)}\n…(cut at ${cap} characters)` : f.text
    budget -= Math.min(f.text.length, cap)
    out.push(`--- ${f.path}\n${text.trimEnd()}`)
  }
  for (const d of folders) {
    const more = d.entries.length >= FILE_LIMITS.folderEntries ? '\n…and more' : ''
    out.push(`--- ${d.path}/ (folder)\n${d.entries.join('\n')}${more}`)
  }
  return out.join('\n\n')
}
