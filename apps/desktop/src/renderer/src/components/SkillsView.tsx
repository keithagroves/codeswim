import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { isMarkdownPath, parseFrontmatter, splitFrontmatter } from '../skill-frontmatter'
import { MarkdownProse } from './MarkdownProse'

const SKILL_FILENAME = 'SKILL.md'

export function SkillsView(): React.JSX.Element {
  const { state, setCurrentSkill, toast } = useStore()
  const current = state.currentSkill
  const selectedPath = current?.file ?? SKILL_FILENAME

  const [content, setContent] = useState<string>('')
  const [original, setOriginal] = useState<string>('')
  const [binary, setBinary] = useState(false)
  const [fileSize, setFileSize] = useState(0)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  // 'rendered' shows MarkdownProse; 'raw' shows the textarea. Defaults to
  // rendered for any markdown-ish file and resets on every file load.
  const [viewMode, setViewMode] = useState<'rendered' | 'raw'>('rendered')
  const loadId = useRef(0)

  const isAgents = current?.kind === 'agents'
  const isReadOnly = current?.scope === 'builtin'
  const isLinked = !isAgents && !!current?.linkTarget
  const dirty = content !== original
  const renderable = isMarkdownPath(selectedPath) && !binary

  useEffect(() => {
    const id = ++loadId.current
    if (!current) {
      void Promise.resolve().then(() => {
        if (loadId.current !== id) return
        setContent('')
        setOriginal('')
        setBinary(false)
        setFileSize(0)
      })
      return
    }
    setLoading(true)
    void (async () => {
      try {
        if (current.kind === 'agents') {
          const scope = current.scope === 'global' ? 'global' : 'workspace'
          const result = await window.api.agentsDocRead(scope, state.rootPath)
          if (loadId.current !== id) return
          setBinary(false)
          setFileSize(result.size)
          setContent(result.content)
          setOriginal(result.content)
          // A missing AGENTS.md opens straight into the editor so the user
          // can start writing; an existing one renders first.
          setViewMode(result.exists ? 'rendered' : 'raw')
          return
        }
        const result = await window.api.readSkillFile(
          current.scope,
          current.name,
          selectedPath,
          state.rootPath
        )
        if (loadId.current !== id) return
        setBinary(result.binary)
        setFileSize(result.size)
        setContent(result.binary ? '' : result.content)
        setOriginal(result.binary ? '' : result.content)
        // Always start in rendered mode so we don't carry an Edit toggle
        // across file switches.
        setViewMode('rendered')
      } catch (err) {
        if (loadId.current !== id) return
        const msg = err instanceof Error ? err.message : String(err)
        toast(`Could not read file: ${msg}`, 'error')
        setContent('')
        setOriginal('')
        setBinary(false)
      } finally {
        if (loadId.current === id) setLoading(false)
      }
    })()
  }, [current, selectedPath, state.rootPath, toast])

  const onSave = useCallback(async () => {
    if (!current || isReadOnly || binary) return
    setSaving(true)
    try {
      if (current.kind === 'agents') {
        const scope = current.scope === 'global' ? 'global' : 'workspace'
        await window.api.agentsDocWrite(scope, content, state.rootPath)
      } else {
        await window.api.writeSkillFile(
          current.scope,
          current.name,
          selectedPath,
          content,
          state.rootPath
        )
      }
      setOriginal(content)
      toast(`Saved ${selectedPath}`, 'info')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast(`Could not save file: ${msg}`, 'error')
    } finally {
      setSaving(false)
    }
  }, [binary, content, current, isReadOnly, selectedPath, state.rootPath, toast])

  const onOpenInEditor = useCallback(async () => {
    if (!current) return
    if (dirty) {
      const ok = window.confirm(
        'You have unsaved changes. Open in editor anyway? Your external editor may overwrite them.'
      )
      if (!ok) return
    }
    try {
      if (current.kind === 'agents') {
        const scope = current.scope === 'global' ? 'global' : 'workspace'
        await window.api.agentsDocOpenInEditor(scope, state.rootPath)
      } else {
        await window.api.openSkillInEditor(
          current.scope,
          current.name,
          state.rootPath,
          selectedPath
        )
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast(`Could not open in editor: ${msg}`, 'error')
    }
  }, [current, dirty, selectedPath, state.rootPath, toast])

  const onDelete = useCallback(async () => {
    if (!current || isReadOnly) return
    const message = current.linkTarget
      ? `Unlink "${current.name}" from this scope? The original at ${current.linkTarget} won't be touched.`
      : `Delete skill "${current.name}"? This removes the entire folder.`
    const ok = window.confirm(message)
    if (!ok) return
    try {
      await window.api.deleteSkill(current.scope, current.name, state.rootPath)
      setCurrentSkill(null)
      toast(
        current.linkTarget
          ? `Unlinked ${current.scope}/${current.name}`
          : `Deleted ${current.scope}/${current.name}`,
        'info'
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast(`Could not delete skill: ${msg}`, 'error')
    }
  }, [current, isReadOnly, setCurrentSkill, state.rootPath, toast])

  if (!current) {
    return (
      <div className="skills-empty-state">
        <h2>Tools</h2>
        <p>
          Tools are capabilities the agent can pick up. Pick one from the panel to view or edit it.
          The tabs split them by kind:
        </p>
        <ul className="skills-help-list">
          <li>
            <strong>Skills</strong> — markdown prompts the agent reaches for. Workspace skills live
            in <code>.agents/skills/</code> in the current folder; global skills in{' '}
            <code>~/.agents/skills/</code>, shared across every workspace.
          </li>
          <li>
            <strong>MCP</strong> — Model Context Protocol servers (coming soon).
          </li>
          <li>
            <strong>Context</strong> — the agent instructions (<code>AGENTS.md</code>, local and
            global) and the read-only system prompts codeswim ships.
          </li>
        </ul>
      </div>
    )
  }

  return (
    <div className="skills-view">
      <div className="skills-view-header">
        <div className="skills-view-title">
          {isAgents ? (
            <>
              <span className={`skills-scope skills-scope-${current.scope}`}>{current.scope}</span>
              <code className="skills-view-file">AGENTS.md</code>
            </>
          ) : (
            <>
              <span className={`skills-scope skills-scope-${current.scope}`}>{current.scope}</span>
              <span className="skills-view-name">{current.name}</span>
              <span className="skills-view-sep">/</span>
              <code className="skills-view-file">{selectedPath}</code>
            </>
          )}
          {isReadOnly ? <span className="skills-badge">read-only</span> : null}
          {isLinked ? (
            <span
              className="skills-badge skills-badge-link"
              title={`linked from ${current.linkTarget}`}
            >
              linked
            </span>
          ) : null}
          {dirty && !isReadOnly && !binary ? (
            <span className="skills-dirty-dot" title="Unsaved" />
          ) : null}
          {fileSize > 0 ? <span className="skills-file-size">{formatBytes(fileSize)}</span> : null}
        </div>
        <div className="skills-view-actions">
          {renderable ? (
            <button
              className="secondary"
              onClick={() => setViewMode((prev) => (prev === 'rendered' ? 'raw' : 'rendered'))}
              title={viewMode === 'rendered' ? 'Edit raw markdown' : 'Show rendered view'}
            >
              {viewMode === 'rendered' ? (isReadOnly ? 'View raw' : 'Edit') : 'Done'}
            </button>
          ) : null}
          <button
            className="secondary"
            onClick={() => void onOpenInEditor()}
            title="Open the selected file in your system's default editor"
          >
            Open in editor
          </button>
          {!isReadOnly ? (
            <>
              <button
                className="primary"
                onClick={() => void onSave()}
                disabled={!dirty || saving || binary}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              {!isAgents ? (
                <button className="secondary" onClick={() => void onDelete()} disabled={saving}>
                  {isLinked ? 'Unlink' : 'Delete'}
                </button>
              ) : null}
            </>
          ) : null}
          <button className="secondary" onClick={() => setCurrentSkill(null)}>
            Close
          </button>
        </div>
      </div>
      {isLinked ? (
        <div className="skills-link-banner">
          Linked from <code>{current.linkTarget}</code>. Edits write through the symlink to the
          original file.
        </div>
      ) : null}
      {loading ? (
        <div className="skills-loading">Loading…</div>
      ) : binary ? (
        <div className="skills-binary-state">
          Binary file ({formatBytes(fileSize)}) — open in editor to inspect.
        </div>
      ) : renderable && viewMode === 'rendered' ? (
        <RenderedMarkdown source={content} />
      ) : (
        <textarea
          className="skills-editor"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          readOnly={isReadOnly}
          spellCheck={false}
        />
      )}
    </div>
  )
}

function RenderedMarkdown({ source }: { source: string }): React.JSX.Element {
  const { frontmatter, body } = splitFrontmatter(source)
  const meta = parseFrontmatter(frontmatter)
  // Intercept link clicks: route http(s) through window.open so Electron's
  // setWindowOpenHandler can punt them to the OS browser instead of
  // navigating the renderer away. Other schemes / relative paths do
  // nothing for now (we don't yet resolve sibling skill files).
  const onClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    const target = e.target as HTMLElement
    const anchor = target.closest('a')
    if (!anchor) return
    const href = anchor.getAttribute('href') ?? ''
    e.preventDefault()
    if (/^https?:/i.test(href)) {
      window.open(href, '_blank')
    }
  }
  return (
    <div className="skills-rendered" onClick={onClick}>
      {meta.name || meta.description ? (
        <header className="skills-rendered-meta">
          {meta.name ? <h1>{meta.name}</h1> : null}
          {meta.description ? <p>{meta.description}</p> : null}
        </header>
      ) : null}
      <MarkdownProse source={body} headingOffset={0} onNavigate={() => {}} />
    </div>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
