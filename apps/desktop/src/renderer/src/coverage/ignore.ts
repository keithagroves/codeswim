// Shared path-matching for the "Ignore for spec coverage" feature (see
// FileTree.tsx's right-click menu, coverage/run.ts, and CodeView.tsx's
// "not explained yet" banner). Entries in the ignore list are root-relative
// posix paths — either an exact file or a whole directory, in which case
// everything under it is ignored too. Not a full gitignore glob engine, but
// since the on-disk file is .gitignore-style, a trailing `/*` or `/` (the
// natural way to write "this whole directory") is normalized away rather
// than silently matching nothing.
function normalizeEntry(entry: string): string {
  return entry.replace(/\/\*$/, '').replace(/\/$/, '')
}

export function isCoverageIgnored(path: string, ignoreList: readonly string[]): boolean {
  return ignoreList.some((raw) => {
    const entry = normalizeEntry(raw)
    return path === entry || path.startsWith(entry + '/')
  })
}
