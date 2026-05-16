import { useCallback, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react'
import {
  connectAgent,
  getProviderAuthMethods,
  setApiKey,
  type AgentClient,
  type LoadedMessage,
  type ProviderAuthMap
} from './agent'
import { extname, joinPosix, relativeToRoot, resolveRelative, toPosix } from './path-utils'
import {
  StoreContext,
  type AppState,
  type ChatMessage,
  type ChatMessagePart,
  type ChatStatus,
  type FileView,
  type RunningScript,
  type SessionInfo,
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
  chatPanelOpen: true,
  chatSettingsOpen: false,
  sessions: [],
  currentSessionId: null,
  recents: []
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
  | { type: 'chat-toggle-settings' }
  | { type: 'chat-set-settings'; open: boolean }
  | { type: 'sessions-set'; sessions: SessionInfo[] }
  | { type: 'session-set-current'; sessionId: string | null; messages: ChatMessage[] }
  | { type: 'recents-set'; recents: string[] }

function fileViewFor(rel: string): 'diagram' | 'code' {
  return extname(rel) === '.md' ? 'diagram' : 'code'
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'set-root':
      return { ...initialState, rootPath: action.rootPath, recents: state.recents }
    case 'clear-root':
      return { ...initialState, recents: state.recents }
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
    case 'chat-toggle-settings':
      return { ...state, chatSettingsOpen: !state.chatSettingsOpen }
    case 'chat-set-settings':
      return { ...state, chatSettingsOpen: action.open }
    case 'sessions-set':
      return { ...state, sessions: action.sessions }
    case 'session-set-current':
      return {
        ...state,
        currentSessionId: action.sessionId,
        chatMessages: action.messages
      }
    case 'recents-set':
      return { ...state, recents: action.recents }
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

  // Converts opencode's `LoadedMessage[]` into our `ChatMessage[]` for the
  // chat list. Filters out empty messages (no displayable parts).
  const toChatMessages = (messages: LoadedMessage[]): ChatMessage[] =>
    messages
      .map((m) => ({
        id: m.id,
        role: m.role,
        parts: m.parts.map((p) => ({
          id: p.id,
          kind: p.kind,
          text: p.text,
          tool: p.tool,
          status: p.status,
          metadata: p.metadata
        }))
      }))
      .filter((m) => m.parts.length > 0)

  const ensureAgent = useCallback(
    async (rootPath: string): Promise<AgentClient | null> => {
      if (agentRef.current) return agentRef.current
      try {
        dispatch({ type: 'chat-status', status: 'connecting' })
        const conn = await window.api.startHarness(rootPath)
        const agent = await connectAgent(conn.url, rootPath)
        agentRef.current = agent

        // Populate the session list and load the most recent session (or
        // create one if there's no history for this workspace yet).
        const sessions = await agent.listSessions()
        dispatch({ type: 'sessions-set', sessions })

        if (sessions.length === 0) {
          const created = await agent.createSession()
          dispatch({ type: 'sessions-set', sessions: [created] })
          dispatch({ type: 'session-set-current', sessionId: created.id, messages: [] })
        } else {
          const latest = sessions[0]
          const messages = await agent.loadMessages(latest.id)
          dispatch({
            type: 'session-set-current',
            sessionId: latest.id,
            messages: toChatMessages(messages)
          })
        }

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
      const sessionId = stateRef.current.currentSessionId
      if (!sessionId) {
        toast('No active session — try opening the folder again.', 'error')
        return
      }

      const userMsgId = `u-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      dispatch({
        type: 'chat-add-message',
        message: { id: userMsgId, role: 'user', parts: [{ kind: 'text', text: trimmed }] }
      })
      dispatch({ type: 'chat-status', status: 'thinking' })

      try {
        const reply = await agent.send(sessionId, trimmed)
        for (const part of reply.parts) {
          dispatch({ type: 'chat-upsert-part', messageID: reply.messageID, part })
        }
        dispatch({ type: 'chat-status', status: 'ready' })

        // Session title may have been auto-filled by opencode based on the
        // first user prompt. Refresh the sessions list to pick that up.
        void agent.listSessions().then((sessions) => {
          dispatch({ type: 'sessions-set', sessions })
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        dispatch({ type: 'chat-status', status: 'error', error: msg })
        toast(`Agent error: ${msg}`, 'error')
      }
    },
    [ensureAgent, toast]
  )

  const newSession = useCallback(async () => {
    const root = stateRef.current.rootPath
    if (!root) return
    const agent = await ensureAgent(root)
    if (!agent) return
    try {
      const created = await agent.createSession()
      const sessions = await agent.listSessions()
      dispatch({ type: 'sessions-set', sessions })
      dispatch({ type: 'session-set-current', sessionId: created.id, messages: [] })
      dispatch({ type: 'chat-status', status: 'ready' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast(`Couldn't create session: ${msg}`, 'error')
    }
  }, [ensureAgent, toast])

  const switchSession = useCallback(
    async (sessionId: string) => {
      const root = stateRef.current.rootPath
      if (!root) return
      const agent = await ensureAgent(root)
      if (!agent) return
      try {
        dispatch({ type: 'chat-status', status: 'connecting' })
        const messages = await agent.loadMessages(sessionId)
        dispatch({
          type: 'session-set-current',
          sessionId,
          messages: toChatMessages(messages)
        })
        dispatch({ type: 'chat-status', status: 'ready' })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        dispatch({ type: 'chat-status', status: 'error', error: msg })
        toast(`Couldn't load session: ${msg}`, 'error')
      }
    },
    [ensureAgent, toast]
  )

  const refreshSessions = useCallback(async () => {
    const root = stateRef.current.rootPath
    if (!root) return
    const agent = agentRef.current
    if (!agent) return
    try {
      const sessions = await agent.listSessions()
      dispatch({ type: 'sessions-set', sessions })
    } catch {
      // best-effort
    }
  }, [])

  const toggleChatPanel = useCallback(() => dispatch({ type: 'chat-toggle-panel' }), [])
  const toggleChatSettings = useCallback(
    () => dispatch({ type: 'chat-toggle-settings' }),
    []
  )

  const fetchProviderMethods = useCallback(async (): Promise<ProviderAuthMap> => {
    const root = stateRef.current.rootPath
    if (!root) throw new Error('Open a folder first')
    const conn = await window.api.startHarness(root)
    return getProviderAuthMethods(conn.url, root)
  }, [])

  const configureProvider = useCallback(
    async (provider: string, apiKey: string): Promise<void> => {
      const root = stateRef.current.rootPath
      if (!root) throw new Error('Open a folder first')
      const conn = await window.api.startHarness(root)
      await setApiKey(conn.url, root, provider, apiKey)
      // Reconnect with the new credentials. If we already had a connected
      // agent (settings opened from a working session), close it first so
      // the next call picks up the new provider list.
      if (agentRef.current) {
        await agentRef.current.close().catch(() => {})
        agentRef.current = null
      }
      await ensureAgent(root)
      dispatch({ type: 'chat-set-settings', open: false })
    },
    [ensureAgent]
  )

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

  const openWorkspace = useCallback(
    async (picked: string) => {
      // Drop any agent attached to a previous workspace; the new harness
      // will be started lazily on the first chat or eagerly below.
      void agentRef.current?.close().catch(() => {})
      agentRef.current = null
      void window.api.stopHarness().catch(() => {})
      dispatch({ type: 'set-root', rootPath: picked })

      const [scripts, entry, tree, recents] = await Promise.all([
        window.api.readPackageScripts(picked),
        findEntryFile(picked),
        window.api.listTree(picked).catch(() => [] as TreeNode[]),
        window.api.addRecent(picked).catch(() => [] as string[])
      ])
      dispatch({ type: 'set-scripts', scripts })
      dispatch({ type: 'set-tree', tree })
      if (recents.length > 0) dispatch({ type: 'recents-set', recents })

      await window.api.watch(picked)

      // Connect the agent eagerly so this workspace's session list and
      // most recent conversation load right away, without waiting for the
      // first chat send.
      void ensureAgent(picked)

      if (!entry) {
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
    },
    [ensureAgent, findEntryFile, readFileSafe, toast]
  )

  const pickRoot = useCallback(async () => {
    const picked = await window.api.pickFolder()
    if (!picked) return
    await openWorkspace(picked)
  }, [openWorkspace])

  const newProject = useCallback(async () => {
    try {
      const result = await window.api.newProject()
      if (!result) return
      await openWorkspace(result.path)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast(`Could not create project: ${msg}`, 'error')
    }
  }, [openWorkspace, toast])

  const openRecent = useCallback(
    async (path: string) => {
      await openWorkspace(path)
    },
    [openWorkspace]
  )

  const clearRecents = useCallback(async () => {
    try {
      const next = await window.api.clearRecents()
      dispatch({ type: 'recents-set', recents: next })
    } catch {
      // ignore
    }
  }, [])

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
    return window.api.onHarnessExit(({ code, signal, stderrTail }) => {
      agentRef.current = null
      const tail = stderrTail.length > 0 ? `\n\nLast stderr:\n${stderrTail.slice(-10).join('\n')}` : ''
      const sigPart = signal ? `, signal ${signal}` : ''
      dispatch({
        type: 'chat-status',
        status: 'error',
        error: `opencode exited (code ${code ?? 'null'}${sigPart})${tail}`
      })
    })
  }, [])

  // Native menu bar: File → Open Folder…
  useEffect(() => {
    return window.api.onMenuOpenFolder(() => {
      void pickRoot()
    })
  }, [pickRoot])

  // Native menu bar: File → New Project…
  useEffect(() => {
    return window.api.onMenuNewProject(() => {
      void newProject()
    })
  }, [newProject])

  // Native menu bar: File → Open Recent → <path>
  useEffect(() => {
    return window.api.onMenuOpenRecent((path) => {
      void openRecent(path)
    })
  }, [openRecent])

  // Native menu bar: File → Open Recent → Clear Recents
  useEffect(() => {
    return window.api.onMenuRecentsCleared(() => {
      dispatch({ type: 'recents-set', recents: [] })
    })
  }, [])

  // Initial load of recents so the start screen has them right away.
  useEffect(() => {
    void window.api
      .getRecents()
      .then((recents) => dispatch({ type: 'recents-set', recents }))
      .catch(() => {})
  }, [])

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
      toggleChatPanel,
      toggleChatSettings,
      fetchProviderMethods,
      configureProvider,
      newSession,
      switchSession,
      refreshSessions,
      newProject,
      openRecent,
      clearRecents
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
      toggleChatPanel,
      toggleChatSettings,
      fetchProviderMethods,
      configureProvider,
      newSession,
      switchSession,
      refreshSessions,
      newProject,
      openRecent,
      clearRecents
    ]
  )

  return <StoreContext.Provider value={api}>{children}</StoreContext.Provider>
}
