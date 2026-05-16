import { useCallback, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react'
import { connectAgent, type AgentClient } from './agent'
import { extname, joinPosix, relativeToRoot, resolveRelative, toPosix } from './path-utils'
import {
  StoreContext,
  type AppState,
  type ChatMessage,
  type ChatMessagePart,
  type ChatStatus,
  type FileView,
  type RunningScript,
  type StoreApi,
  type Toast,
  type TreeNode,
  type View
} from './store'

const initialState: AppState = {
  rootPath: null,
  currentFile: null,
  breadcrumbs: [],
  view: 'diagram',
  fileContents: null,
  loading: false,
  toasts: [],
  scripts: [],
  runningScript: null,
  prevView: null,
  tree: null,
  sidebarOpen: true,
  chatStatus: 'idle',
  chatError: null,
  chatMessages: [],
  chatPanelOpen: true
}

type Action =
  | { type: 'set-root'; rootPath: string }
  | { type: 'clear-root' }
  | {
      type: 'load-success'
      file: string
      contents: string
      view: 'diagram' | 'code'
      pushBreadcrumb: boolean
      previous: string | null
    }
  | {
      type: 'pop-to'
      index: number
      file: string
      contents: string
      view: 'diagram' | 'code'
    }
  | { type: 'set-loading'; loading: boolean }
  | { type: 'add-toast'; toast: Toast }
  | { type: 'remove-toast'; id: number }
  | { type: 'set-scripts'; scripts: string[] }
  | { type: 'script-started'; name: string; startedAt: number }
  | { type: 'script-output'; name: string; chunk: string }
  | { type: 'script-exited'; name: string; code: number | null; signal: string | null }
  | { type: 'show-output' }
  | { type: 'hide-output' }
  | { type: 'set-tree'; tree: TreeNode[] }
  | { type: 'toggle-sidebar' }
  | { type: 'toggle-source' }
  | { type: 'set-view'; view: FileView }
  | { type: 'chat-status'; status: ChatStatus; error?: string | null }
  | { type: 'chat-add-message'; message: ChatMessage }
  | { type: 'chat-upsert-part'; messageID: string; part: ChatMessagePart & { id: string } }
  | { type: 'chat-clear' }
  | { type: 'chat-toggle-panel' }

function fileViewFor(rel: string): 'diagram' | 'code' {
  return extname(rel) === '.md' ? 'diagram' : 'code'
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'set-root':
      return { ...initialState, rootPath: action.rootPath }
    case 'clear-root':
      return initialState
    case 'load-success': {
      const breadcrumbs =
        action.pushBreadcrumb && action.previous
          ? [...state.breadcrumbs, action.previous]
          : state.breadcrumbs
      return {
        ...state,
        currentFile: action.file,
        fileContents: action.contents,
        view: action.view,
        breadcrumbs,
        loading: false,
        prevView: null
      }
    }
    case 'pop-to': {
      const breadcrumbs = state.breadcrumbs.slice(0, action.index)
      return {
        ...state,
        currentFile: action.file,
        fileContents: action.contents,
        view: action.view,
        breadcrumbs,
        loading: false,
        prevView: null
      }
    }
    case 'set-loading':
      return { ...state, loading: action.loading }
    case 'add-toast':
      return { ...state, toasts: [...state.toasts, action.toast] }
    case 'remove-toast':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) }
    case 'set-scripts':
      return { ...state, scripts: action.scripts }
    case 'script-started': {
      const running: RunningScript = {
        name: action.name,
        status: 'running',
        exitCode: null,
        signal: null,
        output: '',
        startedAt: action.startedAt
      }
      const prevView = state.view === 'output' ? state.prevView : (state.view as 'diagram' | 'code')
      return { ...state, runningScript: running, view: 'output', prevView }
    }
    case 'script-output': {
      if (!state.runningScript || state.runningScript.name !== action.name) return state
      return {
        ...state,
        runningScript: {
          ...state.runningScript,
          output: state.runningScript.output + action.chunk
        }
      }
    }
    case 'script-exited': {
      if (!state.runningScript || state.runningScript.name !== action.name) return state
      return {
        ...state,
        runningScript: {
          ...state.runningScript,
          status: 'exited',
          exitCode: action.code,
          signal: action.signal
        }
      }
    }
    case 'show-output': {
      if (!state.runningScript) return state
      const prevView = state.view === 'output' ? state.prevView : (state.view as 'diagram' | 'code')
      return { ...state, view: 'output', prevView }
    }
    case 'hide-output': {
      if (state.view !== 'output') return state
      const target: View =
        state.prevView ?? (state.currentFile ? fileViewFor(state.currentFile) : 'diagram')
      return { ...state, view: target, prevView: null }
    }
    case 'set-tree':
      return { ...state, tree: action.tree }
    case 'toggle-sidebar':
      return { ...state, sidebarOpen: !state.sidebarOpen }
    case 'toggle-source': {
      // Only meaningful for markdown files. Flip rendered <-> raw source.
      if (!state.currentFile) return state
      if (extname(state.currentFile) !== '.md') return state
      if (state.view === 'code') return { ...state, view: 'diagram' }
      return { ...state, view: 'code' }
    }
    case 'set-view': {
      if (!state.currentFile) return state
      const isMd = extname(state.currentFile) === '.md'
      // Non-markdown files only support 'code'.
      if (!isMd && action.view !== 'code') return state
      return { ...state, view: action.view, prevView: null }
    }
    case 'chat-status':
      return { ...state, chatStatus: action.status, chatError: action.error ?? null }
    case 'chat-add-message':
      return { ...state, chatMessages: [...state.chatMessages, action.message] }
    case 'chat-upsert-part': {
      const messages = state.chatMessages.slice()
      let msgIdx = messages.findIndex((m) => m.id === action.messageID)
      if (msgIdx < 0) {
        messages.push({ id: action.messageID, role: 'assistant', parts: [action.part] })
        return { ...state, chatMessages: messages }
      }
      const msg = messages[msgIdx]
      const partIdx = msg.parts.findIndex((p) => 'id' in p && p.id === action.part.id)
      const nextParts = msg.parts.slice()
      if (partIdx < 0) nextParts.push(action.part)
      else nextParts[partIdx] = action.part
      messages[msgIdx] = { ...msg, parts: nextParts }
      return { ...state, chatMessages: messages }
    }
    case 'chat-clear':
      return { ...state, chatMessages: [], chatStatus: 'idle', chatError: null }
    case 'chat-toggle-panel':
      return { ...state, chatPanelOpen: !state.chatPanelOpen }
    default:
      return state
  }
}

let toastSeq = 1

export function StoreProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialState)
  const agentRef = useRef<AgentClient | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state

  const toast = useCallback((message: string, kind: 'info' | 'error' = 'info') => {
    const id = toastSeq++
    dispatch({ type: 'add-toast', toast: { id, message, kind } })
    setTimeout(() => dispatch({ type: 'remove-toast', id }), 4000)
  }, [])

  const ensureAgent = useCallback(
    async (rootPath: string): Promise<AgentClient | null> => {
      if (agentRef.current) return agentRef.current
      try {
        dispatch({ type: 'chat-status', status: 'connecting' })
        const conn = await window.api.startHarness(rootPath)
        const agent = await connectAgent(conn.url, rootPath)
        agentRef.current = agent
        agent.on((event) => {
          if (event.kind === 'part-updated') {
            dispatch({
              type: 'chat-upsert-part',
              messageID: event.messageID,
              part: event.part
            })
          } else if (event.kind === 'session-idle') {
            dispatch({ type: 'chat-status', status: 'ready' })
          } else if (event.kind === 'session-error') {
            dispatch({ type: 'chat-status', status: 'error', error: event.message })
          }
        })
        dispatch({ type: 'chat-status', status: 'ready' })
        return agent
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        dispatch({ type: 'chat-status', status: 'error', error: msg })
        return null
      }
    },
    []
  )

  const sendChat = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      const root = stateRef.current.rootPath
      if (!root) {
        toast('Open a folder before chatting with the agent.', 'error')
        return
      }
      const agent = await ensureAgent(root)
      if (!agent) return

      const userMsgId = `u-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      dispatch({
        type: 'chat-add-message',
        message: { id: userMsgId, role: 'user', parts: [{ kind: 'text', text: trimmed }] }
      })
      dispatch({ type: 'chat-status', status: 'thinking' })

      try {
        await agent.send(trimmed)
        // Reply parts arrive via the event subscription set up in ensureAgent.
        // chat-status flips back to 'ready' on session.idle.
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        dispatch({ type: 'chat-status', status: 'error', error: msg })
        toast(`Agent error: ${msg}`, 'error')
      }
    },
    [ensureAgent, toast]
  )

  const toggleChatPanel = useCallback(() => dispatch({ type: 'chat-toggle-panel' }), [])

  const readFileSafe = useCallback(
    async (
      rootPath: string,
      relPath: string
    ): Promise<{ contents: string; view: 'diagram' | 'code' } | null> => {
      const abs = joinPosix(toPosix(rootPath), relPath)
      try {
        const contents = await window.api.readFile(abs)
        return { contents, view: fileViewFor(relPath) }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toast(`Could not read ${relPath}: ${msg}`, 'error')
        return null
      }
    },
    [toast]
  )

  const navigateAbsolute = useCallback(
    async (relPath: string, pushBreadcrumb: boolean) => {
      if (!state.rootPath) return
      dispatch({ type: 'set-loading', loading: true })
      const previous = state.currentFile
      const result = await readFileSafe(state.rootPath, relPath)
      if (!result) {
        dispatch({ type: 'set-loading', loading: false })
        return
      }
      dispatch({
        type: 'load-success',
        file: relPath,
        contents: result.contents,
        view: result.view,
        pushBreadcrumb,
        previous
      })
    },
    [readFileSafe, state.rootPath, state.currentFile]
  )

  const navigateRelative = useCallback(
    async (target: string) => {
      if (!state.currentFile) return
      const resolved = resolveRelative(state.currentFile, target)
      await navigateAbsolute(resolved, true)
    },
    [navigateAbsolute, state.currentFile]
  )

  const popTo = useCallback(
    async (index: number) => {
      if (!state.rootPath) return
      const stack = state.breadcrumbs
      if (index < 0 || index >= stack.length) return
      const target = stack[index]
      const result = await readFileSafe(state.rootPath, target)
      if (!result) return
      dispatch({
        type: 'pop-to',
        index,
        file: target,
        contents: result.contents,
        view: result.view
      })
    },
    [readFileSafe, state.rootPath, state.breadcrumbs]
  )

  const findEntryFile = useCallback(async (rootPath: string): Promise<string | null> => {
    const files = await window.api.listMarkdown(rootPath)
    if (files.length === 0) return null
    const root = toPosix(rootPath)
    const relList = files
      .map((f) => relativeToRoot(root, toPosix(f)))
      .filter((p): p is string => p !== null)
    const overview = relList.find((p) => p.toLowerCase() === 'overview.md')
    if (overview) return overview
    relList.sort((a, b) => {
      const da = a.split('/').length
      const db = b.split('/').length
      if (da !== db) return da - db
      return a.localeCompare(b)
    })
    return relList[0] ?? null
  }, [])

  const refreshTree = useCallback(async () => {
    const root = state.rootPath
    if (!root) return
    try {
      const tree = await window.api.listTree(root)
      dispatch({ type: 'set-tree', tree })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast(`Could not read folder tree: ${msg}`, 'error')
    }
  }, [state.rootPath, toast])

  const pickRoot = useCallback(async () => {
    const picked = await window.api.pickFolder()
    if (!picked) return
    // Drop any agent attached to a previous workspace; the new harness will
    // be started lazily on the first chat or eagerly below.
    void agentRef.current?.close().catch(() => {})
    agentRef.current = null
    void window.api.stopHarness().catch(() => {})
    dispatch({ type: 'set-root', rootPath: picked })

    const [scripts, entry, tree] = await Promise.all([
      window.api.readPackageScripts(picked),
      findEntryFile(picked),
      window.api.listTree(picked).catch(() => [] as TreeNode[])
    ])
    dispatch({ type: 'set-scripts', scripts })
    dispatch({ type: 'set-tree', tree })

    await window.api.watch(picked)

    if (!entry) {
      // No markdown found — leave the user on the empty state with the
      // sidebar open so they can pick a file manually.
      toast('No markdown files found. Pick a file from the sidebar.', 'info')
      return
    }
    const result = await readFileSafe(picked, entry)
    if (!result) return
    dispatch({
      type: 'load-success',
      file: entry,
      contents: result.contents,
      view: result.view,
      pushBreadcrumb: false,
      previous: null
    })
  }, [findEntryFile, readFileSafe, toast])

  const reload = useCallback(async () => {
    if (!state.rootPath || !state.currentFile) return
    const result = await readFileSafe(state.rootPath, state.currentFile)
    if (!result) return
    dispatch({
      type: 'load-success',
      file: state.currentFile,
      contents: result.contents,
      view: result.view,
      pushBreadcrumb: false,
      previous: null
    })
  }, [readFileSafe, state.rootPath, state.currentFile])

  const runScript = useCallback(
    async (name: string) => {
      if (!state.rootPath) return
      try {
        dispatch({ type: 'script-started', name, startedAt: Date.now() })
        await window.api.runScript(state.rootPath, name)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toast(`Could not run ${name}: ${msg}`, 'error')
        dispatch({ type: 'script-exited', name, code: -1, signal: null })
      }
    },
    [state.rootPath, toast]
  )

  const killScript = useCallback(async () => {
    try {
      await window.api.killScript()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast(`Could not stop script: ${msg}`, 'error')
    }
  }, [toast])

  const showOutput = useCallback(() => dispatch({ type: 'show-output' }), [])
  const hideOutput = useCallback(() => dispatch({ type: 'hide-output' }), [])
  const toggleSidebar = useCallback(() => dispatch({ type: 'toggle-sidebar' }), [])
  const toggleSource = useCallback(() => dispatch({ type: 'toggle-source' }), [])
  const setView = useCallback((view: FileView) => dispatch({ type: 'set-view', view }), [])

  // Live reload: re-read the current file when it changes on disk.
  useEffect(() => {
    const unsub = window.api.onFileChanged((absPath) => {
      if (!state.rootPath || !state.currentFile) return
      const rel = relativeToRoot(toPosix(state.rootPath), toPosix(absPath))
      if (rel === state.currentFile) {
        void reload()
      }
    })
    return unsub
  }, [reload, state.rootPath, state.currentFile])

  // Refresh the file tree when files are added/removed.
  useEffect(() => {
    if (!state.rootPath) return
    const unsub = window.api.onTreeChanged(() => {
      void refreshTree()
    })
    return unsub
  }, [refreshTree, state.rootPath])

  // Stream script output / exit events from the main process into state.
  useEffect(() => {
    const unsubOut = window.api.onScriptOutput((p) => {
      dispatch({ type: 'script-output', name: p.name, chunk: p.chunk })
    })
    const unsubExit = window.api.onScriptExit((p) => {
      dispatch({
        type: 'script-exited',
        name: p.name,
        code: p.code,
        signal: p.signal ?? null
      })
    })
    return () => {
      unsubOut()
      unsubExit()
    }
  }, [])

  // Stop the watcher, any running script, and the harness on unmount.
  useEffect(() => {
    return () => {
      void window.api.unwatch()
      void window.api.killScript()
      void agentRef.current?.close().catch(() => {})
      void window.api.stopHarness().catch(() => {})
    }
  }, [])

  // Surface harness exit as a toast so the user knows when the agent stops
  // working — useful when the spawned opencode crashes.
  useEffect(() => {
    return window.api.onHarnessExit(({ code }) => {
      agentRef.current = null
      dispatch({
        type: 'chat-status',
        status: 'error',
        error: `opencode exited (code ${code ?? 'null'})`
      })
    })
  }, [])

  // Native menu bar: File → Open Folder…
  useEffect(() => {
    return window.api.onMenuOpenFolder(() => {
      void pickRoot()
    })
  }, [pickRoot])

  const api = useMemo<StoreApi>(
    () => ({
      state,
      pickRoot,
      navigateRelative,
      navigateAbsolute,
      popTo,
      toast,
      reload,
      runScript,
      killScript,
      showOutput,
      hideOutput,
      toggleSidebar,
      toggleSource,
      setView,
      refreshTree,
      sendChat,
      toggleChatPanel
    }),
    [
      state,
      pickRoot,
      navigateRelative,
      navigateAbsolute,
      popTo,
      toast,
      reload,
      runScript,
      killScript,
      showOutput,
      hideOutput,
      toggleSidebar,
      toggleSource,
      setView,
      refreshTree,
      sendChat,
      toggleChatPanel
    ]
  )

  return <StoreContext.Provider value={api}>{children}</StoreContext.Provider>
}
