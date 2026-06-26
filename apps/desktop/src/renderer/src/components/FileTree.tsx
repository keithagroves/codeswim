import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import type { TreeNode } from '../store'

function pathPrefixes(rel: string): string[] {
  // For "a/b/c.md" returns ["a", "a/b"] — every ancestor directory.
  const parts = rel.split('/').slice(0, -1)
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    out.push(parts.slice(0, i + 1).join('/'))
  }
  return out
}

// Right-pointing chevron; CSS rotates it 90° when the folder is open.
function ChevronIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
      <path d="M6 3.5 10.5 8 6 12.5z" />
    </svg>
  )
}

function FolderIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path d="M1.5 4.25C1.5 3.56 2.06 3 2.75 3h2.88c.4 0 .77.19 1 .5l.6.8c.1.13.25.2.4.2h4.62c.69 0 1.25.56 1.25 1.25v6.5c0 .69-.56 1.25-1.25 1.25H2.75c-.69 0-1.25-.56-1.25-1.25z" />
    </svg>
  )
}

// Page with a folded top-right corner. evenodd so the corner reads as a fold.
function FileIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M4 1.5a.5.5 0 0 0-.5.5v12a.5.5 0 0 0 .5.5h8a.5.5 0 0 0 .5-.5V5.62a.5.5 0 0 0-.15-.35L8.73 1.65a.5.5 0 0 0-.35-.15zM9 2.6 11.4 5H9.5A.5.5 0 0 1 9 4.5z"
      />
    </svg>
  )
}

// Markdown files are the documents this app is built around; give them the
// accent tint so they stand out from plain source/config files.
function isMarkdown(name: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(name)
}

interface NodeRowProps {
  node: TreeNode
  depth: number
  isOpen: (path: string) => boolean
  toggle: (path: string, open: boolean) => void
  open: (path: string) => void
  currentFile: string | null
}

function NodeRow({
  node,
  depth,
  isOpen,
  toggle,
  open,
  currentFile
}: NodeRowProps): React.JSX.Element {
  const isDir = node.kind === 'dir'
  const opened = isDir && isOpen(node.path)
  const isCurrent = !isDir && node.path === currentFile

  const onClick = (): void => {
    if (isDir) toggle(node.path, opened)
    else open(node.path)
  }

  return (
    <>
      <button
        type="button"
        className={`tree-row ${isCurrent ? 'current' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={onClick}
        title={node.path}
      >
        {isDir ? (
          <>
            <span className={`tree-chevron ${opened ? 'is-open' : ''}`}>
              <ChevronIcon />
            </span>
            <span className={`tree-glyph tree-folder ${opened ? 'is-open' : ''}`}>
              <FolderIcon />
            </span>
          </>
        ) : (
          <>
            <span className="tree-chevron tree-chevron-spacer" aria-hidden="true" />
            <span className={`tree-glyph tree-file ${isMarkdown(node.name) ? 'is-md' : ''}`}>
              <FileIcon />
            </span>
          </>
        )}
        <span className="tree-name">{node.name}</span>
      </button>
      {isDir && opened && node.children
        ? node.children.map((child) => (
            <NodeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              isOpen={isOpen}
              toggle={toggle}
              open={open}
              currentFile={currentFile}
            />
          ))
        : null}
    </>
  )
}

export function FileTree(): React.JSX.Element | null {
  const { state, inspectFile, refreshTree } = useStore()
  // Two sets so we can override the auto-expansion of ancestors of the
  // current file. A path in `opened` is forced open; a path in `closed`
  // is forced closed; otherwise it's open iff it's an ancestor of the
  // current file. This keeps expansion derivable in render — no
  // setState-in-effect.
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set())
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set())

  const ancestors = useMemo(() => {
    if (!state.currentFile) return new Set<string>()
    return new Set(pathPrefixes(state.currentFile))
  }, [state.currentFile])

  // Lazy-load the tree if a root is set but no tree has been fetched yet
  // (e.g., after HMR). The dispatch happens asynchronously inside refreshTree.
  useEffect(() => {
    if (state.rootPath && state.tree === null) void refreshTree()
  }, [state.rootPath, state.tree, refreshTree])

  const isOpen = useCallback(
    (path: string): boolean => {
      if (closed.has(path)) return false
      if (opened.has(path)) return true
      return ancestors.has(path)
    },
    [opened, closed, ancestors]
  )

  const toggle = useCallback((path: string, currentlyOpen: boolean): void => {
    if (currentlyOpen) {
      setOpened((prev) => {
        if (!prev.has(path)) return prev
        const next = new Set(prev)
        next.delete(path)
        return next
      })
      setClosed((prev) => new Set(prev).add(path))
    } else {
      setOpened((prev) => new Set(prev).add(path))
      setClosed((prev) => {
        if (!prev.has(path)) return prev
        const next = new Set(prev)
        next.delete(path)
        return next
      })
    }
  }, [])

  const open = useCallback(
    (path: string): void => {
      void inspectFile(path)
    },
    [inspectFile]
  )

  // Visibility is owned by the parent SidePanel; this component just renders.
  return (
    <aside className="sidebar" aria-label="File tree">
      <div className="sidebar-header">
        <span className="sidebar-title">Files</span>
        <button
          className="sidebar-icon-btn"
          onClick={() => void refreshTree()}
          title="Refresh tree"
        >
          ↻
        </button>
      </div>
      <div className="sidebar-body">
        {state.tree === null ? (
          <div className="sidebar-empty">Loading…</div>
        ) : state.tree.length === 0 ? (
          <div className="sidebar-empty">Folder is empty.</div>
        ) : (
          state.tree.map((node) => (
            <NodeRow
              key={node.path}
              node={node}
              depth={0}
              isOpen={isOpen}
              toggle={toggle}
              open={open}
              currentFile={state.currentFile}
            />
          ))
        )}
      </div>
    </aside>
  )
}
