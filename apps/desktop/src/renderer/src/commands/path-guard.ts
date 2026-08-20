// A relative, POSIX, non-traversing path — the shape every file-bearing
// command's args must satisfy before a handler ever calls into window.api.
// This is a fast, synchronous pre-check done at command-validate time; it is
// NOT the containment boundary. Only the main process can resolve symlinks
// against real disk paths, so `workspace:read-file` re-checks with
// fs.realpath before it ever reads a byte. This guard exists so a malformed
// or malicious relPath is rejected before any IPC round-trip, with a clear
// command-level error instead of a generic IPC failure.
export function assertRelativeWorkspacePath(value: unknown, label = 'path'): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label}: expected a non-empty path`)
  }
  if (value.startsWith('/') || value.startsWith('\\') || /^[a-zA-Z]:[\\/]/.test(value)) {
    throw new Error(`${label}: must be a relative path, got an absolute path`)
  }
  const segments = value.split('/')
  if (segments.some((seg) => seg === '..')) {
    throw new Error(`${label}: must not escape the workspace ("..")`)
  }
}
