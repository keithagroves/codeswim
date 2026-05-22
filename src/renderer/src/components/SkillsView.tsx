import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'

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
  const loadId = useRef(0)

  const isReadOnly = current?.scope === 'builtin'
  const isLinked = !!current?.linkTarget
  const dirty = content !== original

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
      await window.api.writeSkillFile(
        current.scope,
        current.name,
        selectedPath,
        content,
        state.rootPath
      )
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
      await window.api.openSkillInEditor(
        current.scope,
        current.name,
        state.rootPath,
        selectedPath
      )
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
        <h2>Skills</h2>
        <p>
          Skills are markdown prompts the agent can pick up. Pick one from the panel to
          expand it and view its files, or create a new one.
        </p>
        <ul className="skills-help-list">
          <li>
            <strong>Built-in</strong> — the prompts codeswim ships (system prompt and
            MDD coverage notes). Read-only; here so you can see what the agent is
            told by default.
          </li>
          <li>
            <strong>Workspace</strong> — stored in
            <code> .agents/skills/</code> inside the current folder.
          </li>
          <li>
            <strong>Global</strong> — stored in <code>~/.agents/skills/</code>; shared
            across every workspace.
          </li>
        </ul>
      </div>
    )
  }

  return (
    <div className="skills-view">
      <div className="skills-view-header">
        <div className="skills-view-title">
          <span className={`skills-scope skills-scope-${current.scope}`}>
            {current.scope}
          </span>
          <span className="skills-view-name">{current.name}</span>
          <span className="skills-view-sep">/</span>
          <code className="skills-view-file">{selectedPath}</code>
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
          {fileSize > 0 ? (
            <span className="skills-file-size">{formatBytes(fileSize)}</span>
          ) : null}
        </div>
        <div className="skills-view-actions">
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
              <button className="secondary" onClick={() => void onDelete()} disabled={saving}>
                {isLinked ? 'Unlink' : 'Delete'}
              </button>
            </>
          ) : null}
          <button className="secondary" onClick={() => setCurrentSkill(null)}>
            Close
          </button>
        </div>
      </div>
      {isLinked ? (
        <div className="skills-link-banner">
          Linked from <code>{current.linkTarget}</code>. Edits write through the symlink
          to the original file.
        </div>
      ) : null}
      {loading ? (
        <div className="skills-loading">Loading…</div>
      ) : binary ? (
        <div className="skills-binary-state">
          Binary file ({formatBytes(fileSize)}) — open in editor to inspect.
        </div>
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
