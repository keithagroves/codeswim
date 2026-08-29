// Shared path-matching for the "Ignore for spec coverage" feature (see
// FileTree.tsx's right-click menu, coverage/run.ts, and CodeView.tsx's
// "not explained yet" banner). Entries in the ignore list are root-relative
// posix paths — either an exact file or a whole directory, in which case
// everything under it is ignored too.
export function isCoverageIgnored(path: string, ignoreList: readonly string[]): boolean {
  return ignoreList.some((entry) => path === entry || path.startsWith(entry + '/'))
}
