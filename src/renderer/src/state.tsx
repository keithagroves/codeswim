import { useCallback, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react'
import {
  connectAgent,
  getProviderAuthMethods,
  setApiKey,
  type AgentClient,
  type LoadedMessage,
  type PendingQuestion,
  type ProviderAuthMap
} from './agent'
import { runCoverage, buildSyncPrompt } from './coverage/run'
import {
  buildCommitSynthesisPrompt,
  parseCommitMessage,
  type CommitMessage
} from './commit/synthesize'
import { extname, parseTarget, relativeToRoot, resolveRelative, toPosix } from './path-utils'
import {
  StoreContext,
  type AppState,
  type ChatMessage,
  type ChatMessagePart,
  type ChatStatus,
  type FileView,
  type RunEntry,
  type RunningScript,
  type Section,
  type SessionInfo,
  type StoreApi,
  type Toast,
  type TreeNode,
  type View,
  type WorkspaceView
} from './store'

// Canonical section order + the single source of truth for which sections
// exist. Used for the default activity-bar order and to sanitize a stale
// saved order (drop unknowns, re-append any missing).
const DEFAULT_ACTIVITY_ORDER: Section[] = [
  'agent',
  'files',
  'search',
  'skills',
  'git',
  'terminal',
  'chat'
]

const initialState: AppState = {
  rootPath: null,
  workspaceView: 'kanban',
  currentFile: null,
  currentDocumentPath: null,
  sourceExplanationExists: true,
  breadcrumbs: [],
  view: 'diagram',
  fileContents: null,
  loading: false,
  toasts: [],
  runs: [],
  runningScript: null,
  prevView: null,
  tree: null,
  activeSection: 'agent',
  lastActiveSection: 'agent',
  sidePanelWidth: 320,
  activityOrder: [...DEFAULT_ACTIVITY_ORDER],
  currentSkill: null,
  chatStatus: 'idle',
  chatError: null,
  chatMessages: [],
  chatSettingsOpen: false,
  sessions: [],
  currentSessionId: null,
  recents: [],
  pendingQuestion: null
}

type Action =
  | { type: 'set-root'; rootPath: string }
  | { type: 'clear-root' }
  | {
      type: 'load-success'
      file: string
      contents: string
      view: 'diagram' | 'read'
      pushBreadcrumb: boolean
      previous: string | null
      revealNavigator: boolean
      documentPath: string
      sourceExplanationExists: boolean
    }
  | {
      type: 'pop-to'
      index: number
      file: string
      contents: string
      view: 'diagram' | 'read'
      documentPath: string
      sourceExplanationExists: boolean
    }
  | { type: 'set-loading'; loading: boolean }
  | { type: 'add-toast'; toast: Toast }
  | { type: 'remove-toast'; id: number }
  | { type: 'set-runs'; runs: RunEntry[] }
  | { type: 'script-started'; name: string; startedAt: number }
  | { type: 'script-output'; name: string; chunk: string }
  | { type: 'script-exited'; name: string; code: number | null; signal: string | null }
  | { type: 'show-output' }
  | { type: 'hide-output' }
  | { type: 'set-tree'; tree: TreeNode[] }
  | { type: 'toggle-sidebar' }
  | {
      type: 'set-active-section'
      section: Section | null
    }
  | {
      type: 'toggle-active-section'
      section: Section
    }
  | { type: 'set-side-panel-width'; width: number }
  | {
      type: 'set-activity-order'
      order: Section[]
    }
  | {
      type: 'set-current-skill'
      skill: {
        scope: 'global' | 'workspace' | 'builtin'
        name: string
        linkTarget?: string
        file?: string
      } | null
    }
  | { type: 'set-pending-question'; question: PendingQuestion | null }
  | { type: 'set-workspace-view'; view: WorkspaceView }
  | { type: 'chat-status'; status: ChatStatus; error?: string | null }
  | { type: 'chat-add-message'; message: ChatMessage }
  | { type: 'chat-upsert-part'; messageID: string; part: ChatMessagePart & { id: string } }
  | { type: 'chat-clear' }
  | { type: 'chat-toggle-settings' }
  | { type: 'chat-set-settings'; open: boolean }
  | { type: 'sessions-set'; sessions: SessionInfo[] }
  | { type: 'session-set-current'; sessionId: string | null; messages: ChatMessage[] }
  | { type: 'recents-set'; recents: string[] }

function fileViewFor(rel: string): 'diagram' | 'read' {
  return extname(rel) === '.md' ? 'diagram' : 'read'
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
        currentDocumentPath: action.documentPath,
        sourceExplanationExists: action.sourceExplanationExists,
        fileContents: action.contents,
        view: action.view,
        breadcrumbs,
        loading: false,
        prevView: null,
        workspaceView: action.revealNavigator ? 'navigator' : state.workspaceView
      }
    }
    case 'pop-to': {
      const breadcrumbs = state.breadcrumbs.slice(0, action.index)
      return {
        ...state,
        currentFile: action.file,
        currentDocumentPath: action.documentPath,
        sourceExplanationExists: action.sourceExplanationExists,
        fileContents: action.contents,
        view: action.view,
        breadcrumbs,
        loading: false,
        prevView: null,
        workspaceView: 'navigator'
      }
    }
    case 'set-loading':
      return { ...state, loading: action.loading }
    case 'add-toast':
      return { ...state, toasts: [...state.toasts, action.toast] }
    case 'remove-toast':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) }
    case 'set-runs':
      return { ...state, runs: action.runs }
    case 'script-started': {
      const running: RunningScript = {
        name: action.name,
        status: 'running',
        exitCode: null,
        signal: null,
        output: '',
        startedAt: action.startedAt
      }
      const prevView = state.view === 'output' ? state.prevView : (state.view as FileView)
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
      const prevView = state.view === 'output' ? state.prevView : (state.view as FileView)
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
    case 'toggle-sidebar': {
      // Collapse if open; restore the last section if closed.
      if (state.activeSection !== null) return { ...state, activeSection: null }
      return { ...state, activeSection: state.lastActiveSection }
    }
    case 'set-active-section':
      return {
        ...state,
        activeSection: action.section,
        lastActiveSection: action.section ?? state.lastActiveSection
      }
    case 'toggle-active-section': {
      // Clicking the already-active icon collapses; clicking a different
      // icon switches to it (and opens the panel if collapsed).
      const next = state.activeSection === action.section ? null : action.section
      return {
        ...state,
        activeSection: next,
        // Always remember the section the user just interacted with so a
        // later collapse+reopen returns here, not to 'files'.
        lastActiveSection: action.section
      }
    }
    case 'set-side-panel-width':
      return { ...state, sidePanelWidth: Math.max(180, Math.min(700, action.width)) }
    case 'set-activity-order': {
      // Sanitize: dedupe and re-add any missing sections at the end so we
      // never end up with a partial order if the saved one is stale.
      const known = new Set<Section>(DEFAULT_ACTIVITY_ORDER)
      const seen = new Set<Section>()
      const cleaned: Section[] = []
      for (const k of action.order) {
        if (seen.has(k) || !known.has(k)) continue
        cleaned.push(k)
        seen.add(k)
      }
      for (const k of DEFAULT_ACTIVITY_ORDER) {
        if (!seen.has(k)) cleaned.push(k)
      }
      return { ...state, activityOrder: cleaned }
    }
    case 'set-current-skill':
      return { ...state, currentSkill: action.skill }
    case 'set-pending-question':
      return { ...state, pendingQuestion: action.question }
    case 'set-workspace-view': {
      const view =
        state.view === 'output'
          ? (state.prevView ?? (state.currentFile ? fileViewFor(state.currentFile) : 'diagram'))
          : state.view
      return { ...state, workspaceView: action.view, view, prevView: null }
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
        chatMessages: action.messages,
        // Drop any prompt from the previous session — the new session has
        // its own pending-question state which we'll refetch on connect.
        pendingQuestion: null
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

  const ensureAgent = useCallback(async (rootPath: string): Promise<AgentClient | null> => {
    if (agentRef.current) return agentRef.current
    try {
      dispatch({ type: 'chat-status', status: 'connecting' })
      const conn = await window.api.startHarness(rootPath)
      const agent = await connectAgent(conn.url, rootPath)
      agentRef.current = agent

      // Stream incremental parts (text deltas, tool starts, reasoning) into
      // the active session as they arrive, so the user sees the agent
      // working instead of a static "thinking…" placeholder.
      agent.subscribeParts(({ sessionID, messageID, part }) => {
        if (sessionID !== stateRef.current.currentSessionId) return
        dispatch({ type: 'chat-upsert-part', messageID, part })
      })

      // Forward question events for the current session. We only ever
      // render one prompt at a time — opencode shouldn't fire concurrent
      // questions for a single session in practice.
      agent.subscribeQuestions((event) => {
        if (event.kind === 'asked') {
          if (event.question.sessionID !== stateRef.current.currentSessionId) return
          dispatch({ type: 'set-pending-question', question: event.question })
        } else {
          const pending = stateRef.current.pendingQuestion
          if (pending && pending.id === event.requestID) {
            dispatch({ type: 'set-pending-question', question: null })
          }
        }
      })

      // Populate the session list and load the most recent session (or
      // create one if there's no history for this workspace yet).
      const sessions = await agent.listSessions()
      dispatch({ type: 'sessions-set', sessions })

      let activeSessionId: string
      if (sessions.length === 0) {
        const created = await agent.createSession()
        dispatch({ type: 'sessions-set', sessions: [created] })
        dispatch({ type: 'session-set-current', sessionId: created.id, messages: [] })
        activeSessionId = created.id
      } else {
        const latest = sessions[0]
        const messages = await agent.loadMessages(latest.id)
        dispatch({
          type: 'session-set-current',
          sessionId: latest.id,
          messages: toChatMessages(messages)
        })
        activeSessionId = latest.id
      }

      // Pick up any question opencode raised before we connected (e.g.
      // the agent asked a question last session and the user closed the
      // app without answering).
      void agent
        .listPendingQuestions(activeSessionId)
        .then((pending) => {
          if (pending.length > 0) {
            dispatch({ type: 'set-pending-question', question: pending[0] })
          }
        })
        .catch(() => {
          // best-effort; missing pending questions are non-fatal
        })

      dispatch({ type: 'chat-status', status: 'ready' })
      return agent
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      dispatch({ type: 'chat-status', status: 'error', error: msg })
      return null
    }
  }, [])

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

  const openCurrentFileInEditor = useCallback(async (): Promise<void> => {
    const { rootPath, currentFile } = stateRef.current
    if (!rootPath || !currentFile) return
    try {
      await window.api.openWorkspaceFile(rootPath, currentFile)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast(`Could not open ${currentFile}: ${msg}`, 'error')
    }
  }, [toast])

  const createCurrentExplanation = useCallback(async (): Promise<void> => {
    const { currentFile, currentDocumentPath } = stateRef.current
    if (!currentFile || extname(currentFile) === '.md' || !currentDocumentPath) return
    dispatch({ type: 'set-active-section', section: 'agent' })
    await sendChat(`Create the source explanation document \`${currentDocumentPath}\` for \`${currentFile}\`.

Read the source file and the architecture, flow, and decision documents that reference it. Write a concise Markdown document with YAML frontmatter (\`name\`, \`description\`, and \`tags\`) and these sections where relevant:

- Purpose
- Responsibilities
- Inputs and outputs
- Control and data flow
- Dependencies and side effects
- Failure modes
- Related diagrams and decisions

Explain behavior and intent without pasting the implementation. Use relative Markdown links back to the relevant Codeswim documents. Do not add a Mermaid block unless a small diagram materially clarifies the logic.`)
  }, [sendChat])

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
        // Re-hydrate any unanswered question for this session.
        void agent
          .listPendingQuestions(sessionId)
          .then((pending) => {
            if (pending.length > 0) {
              dispatch({ type: 'set-pending-question', question: pending[0] })
            }
          })
          .catch(() => {})
        dispatch({ type: 'chat-status', status: 'ready' })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        dispatch({ type: 'chat-status', status: 'error', error: msg })
        toast(`Couldn't load session: ${msg}`, 'error')
      }
    },
    [ensureAgent, toast]
  )

  const answerQuestion = useCallback(
    async (requestID: string, answers: string[][]): Promise<void> => {
      const agent = agentRef.current
      if (!agent) {
        toast('Agent is not connected.', 'error')
        return
      }
      try {
        await agent.replyToQuestion(requestID, answers)
        // The server will emit `question.replied` which clears state via
        // our subscriber — but clear locally too so the UI doesn't sit on
        // the prompt waiting for the round-trip.
        dispatch({ type: 'set-pending-question', question: null })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toast(`Couldn't answer: ${msg}`, 'error')
      }
    },
    [toast]
  )

  const rejectQuestion = useCallback(
    async (requestID: string): Promise<void> => {
      const agent = agentRef.current
      if (!agent) return
      try {
        await agent.rejectQuestion(requestID)
        dispatch({ type: 'set-pending-question', question: null })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toast(`Couldn't cancel question: ${msg}`, 'error')
      }
    },
    [toast]
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

  const setActiveSection = useCallback(
    (section: Section | null) => dispatch({ type: 'set-active-section', section }),
    []
  )
  const toggleActiveSection = useCallback(
    (section: Section) => dispatch({ type: 'toggle-active-section', section }),
    []
  )
  const setSidePanelWidth = useCallback(
    (width: number) => dispatch({ type: 'set-side-panel-width', width }),
    []
  )
  const setActivityOrder = useCallback(
    (order: Section[]) => dispatch({ type: 'set-activity-order', order }),
    []
  )
  const setCurrentSkill = useCallback(
    (
      skill: {
        scope: 'global' | 'workspace' | 'builtin'
        name: string
        linkTarget?: string
        file?: string
      } | null
    ) => dispatch({ type: 'set-current-skill', skill }),
    []
  )
  const toggleChatSettings = useCallback(() => dispatch({ type: 'chat-toggle-settings' }), [])

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
      relPath: string,
      markdownView: 'diagram' | 'read' = 'diagram'
    ): Promise<{
      contents: string
      view: 'diagram' | 'read'
      documentPath: string
      sourceExplanationExists: boolean
    } | null> => {
      try {
        if (extname(relPath) === '.md') {
          const abs = `${toPosix(rootPath).replace(/\/$/, '')}/${relPath}`
          const contents = await window.api.readFile(abs)
          return {
            contents,
            view: markdownView,
            documentPath: relPath,
            sourceExplanationExists: true
          }
        }
        const explanation = await window.api.readSourceExplanation(rootPath, relPath)
        return {
          contents: explanation.content,
          view: 'read',
          documentPath: explanation.documentPath,
          sourceExplanationExists: explanation.exists
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toast(`Could not read ${relPath}: ${msg}`, 'error')
        return null
      }
    },
    [toast]
  )

  const navigateAbsolute = useCallback(
    async (relPath: string, pushBreadcrumb: boolean, markdownView?: 'diagram' | 'read') => {
      if (!state.rootPath) return
      // The path may carry a legacy #L10-L22 line ref; peel it off before
      // reading. Ranges are not rendered — codeswim explains source behavior
      // instead of showing line ranges.
      const { path } = parseTarget(relPath)
      dispatch({ type: 'set-loading', loading: true })
      const previous = state.currentFile
      const result = await readFileSafe(state.rootPath, path, markdownView)
      if (!result) {
        dispatch({ type: 'set-loading', loading: false })
        return
      }
      dispatch({
        type: 'load-success',
        file: path,
        contents: result.contents,
        view: result.view,
        pushBreadcrumb,
        previous,
        revealNavigator: true,
        documentPath: result.documentPath,
        sourceExplanationExists: result.sourceExplanationExists
      })
    },
    [readFileSafe, state.rootPath, state.currentFile]
  )

  const inspectFile = useCallback(
    (relPath: string): Promise<void> => navigateAbsolute(relPath, true, 'read'),
    [navigateAbsolute]
  )

  const navigateRelative = useCallback(
    async (target: string) => {
      const baseFile = state.currentDocumentPath ?? state.currentFile
      if (!baseFile) return
      // Peel off any legacy line ref so resolveRelative doesn't try to make
      // the fragment part of the path.
      const { path } = parseTarget(target)
      await navigateAbsolute(resolveRelative(baseFile, path), true)
    },
    [navigateAbsolute, state.currentDocumentPath, state.currentFile]
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
        view: result.view,
        documentPath: result.documentPath,
        sourceExplanationExists: result.sourceExplanationExists
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

  const refreshRuns = useCallback(async () => {
    const root = state.rootPath
    if (!root) return
    try {
      const runs = await window.api.listRuns(root)
      dispatch({ type: 'set-runs', runs })
    } catch {
      // Ignore — runs are non-critical and the next refresh will retry.
    }
  }, [state.rootPath])

  const openWorkspace = useCallback(
    async (picked: string) => {
      // Drop any agent attached to a previous workspace; the new harness
      // will be started lazily on the first chat or eagerly below.
      void agentRef.current?.close().catch(() => {})
      agentRef.current = null
      void window.api.stopHarness().catch(() => {})
      dispatch({ type: 'set-root', rootPath: picked })

      const [runs, entry, tree, recents] = await Promise.all([
        window.api.listRuns(picked),
        findEntryFile(picked),
        window.api.listTree(picked).catch(() => [] as TreeNode[]),
        window.api.addRecent(picked).catch(() => [] as string[])
      ])
      dispatch({ type: 'set-runs', runs })
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
        previous: null,
        revealNavigator: false,
        documentPath: result.documentPath,
        sourceExplanationExists: result.sourceExplanationExists
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

  const syncDiagrams = useCallback(async () => {
    const root = stateRef.current.rootPath
    if (!root) {
      toast('Open a folder first.', 'error')
      return
    }
    let report
    try {
      report = await runCoverage(root)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast(`Couldn't audit diagrams: ${msg}`, 'error')
      return
    }
    const issues =
      report.brokenLinks.length +
      report.orphanDiagrams.length +
      report.uncoveredSources.length +
      report.mermaidIssues.length
    if (issues === 0) {
      toast('Diagrams are aligned with the code — nothing to fix.', 'info')
      return
    }
    // Switch to the agent panel so the user sees the conversation.
    dispatch({ type: 'set-active-section', section: 'agent' })
    void sendChat(buildSyncPrompt(report))
  }, [sendChat, toast])

  const synthesizeCommitMessage = useCallback(
    async (diff: string): Promise<CommitMessage> => {
      const root = stateRef.current.rootPath
      if (!root) throw new Error('Open a folder first.')
      const agent = await ensureAgent(root)
      if (!agent) throw new Error('Agent is not connected — configure a provider first.')
      // Ephemeral session so synthesis never pollutes the chat the user
      // sees. `send` is blocking and returns the completed parts, and the
      // streamed parts are dropped because this session id is never the
      // current one.
      const session = await agent.createSession()
      const reply = await agent.send(session.id, buildCommitSynthesisPrompt(diff))
      const text = reply.parts
        .filter((p) => p.kind === 'text' && p.text)
        .map((p) => p.text as string)
        .join('')
        .trim()
      if (!text) throw new Error('The agent returned an empty response.')
      return parseCommitMessage(text)
    },
    [ensureAgent]
  )

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
      previous: null,
      revealNavigator: false,
      documentPath: result.documentPath,
      sourceExplanationExists: result.sourceExplanationExists
    })
  }, [readFileSafe, state.rootPath, state.currentFile])

  const runScript = useCallback(
    async (entry: RunEntry) => {
      if (!state.rootPath) return
      try {
        dispatch({ type: 'script-started', name: entry.name, startedAt: Date.now() })
        await window.api.runEntry(state.rootPath, entry.source, entry.name)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toast(`Could not run ${entry.name}: ${msg}`, 'error')
        dispatch({ type: 'script-exited', name: entry.name, code: -1, signal: null })
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
  const setWorkspaceView = useCallback(
    (view: WorkspaceView) => dispatch({ type: 'set-workspace-view', view }),
    []
  )

  // Live reload: re-read the current file when it changes on disk.
  // Also refresh the runs list when its source files (package.json scripts
  // or .codeswim/runs.json) change, so the agent adding a run shows up in
  // the dropdown without a workspace reload.
  useEffect(() => {
    const unsub = window.api.onFileChanged((absPath) => {
      if (!state.rootPath) return
      const rel = relativeToRoot(toPosix(state.rootPath), toPosix(absPath))
      if (rel === 'package.json' || rel === '.codeswim/runs.json') {
        void refreshRuns()
      }
      if (
        (state.currentFile && rel === state.currentFile) ||
        (state.currentDocumentPath && rel === state.currentDocumentPath)
      ) {
        void reload()
      }
    })
    return unsub
  }, [reload, refreshRuns, state.rootPath, state.currentDocumentPath, state.currentFile])

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
      const tail =
        stderrTail.length > 0 ? `\n\nLast stderr:\n${stderrTail.slice(-10).join('\n')}` : ''
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

  // Restore the side panel width from localStorage on mount, then persist
  // it whenever the user resizes.
  useEffect(() => {
    try {
      const stored = localStorage.getItem('codeswim:sidePanelWidth')
      if (stored) {
        const w = Number.parseInt(stored, 10)
        if (Number.isFinite(w) && w >= 180 && w <= 700) {
          dispatch({ type: 'set-side-panel-width', width: w })
        }
      }
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem('codeswim:sidePanelWidth', String(state.sidePanelWidth))
    } catch {
      // ignore
    }
  }, [state.sidePanelWidth])

  useEffect(() => {
    try {
      const stored = localStorage.getItem('codeswim:activityOrder')
      if (stored) {
        const parsed = JSON.parse(stored)
        if (Array.isArray(parsed)) {
          dispatch({ type: 'set-activity-order', order: parsed })
        }
      }
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem('codeswim:activityOrder', JSON.stringify(state.activityOrder))
    } catch {
      // ignore
    }
  }, [state.activityOrder])

  const api = useMemo<StoreApi>(
    () => ({
      state,
      pickRoot,
      navigateRelative,
      navigateAbsolute,
      inspectFile,
      popTo,
      toast,
      reload,
      runScript,
      killScript,
      showOutput,
      hideOutput,
      toggleSidebar,
      setWorkspaceView,
      openCurrentFileInEditor,
      createCurrentExplanation,
      refreshTree,
      sendChat,
      setActiveSection,
      toggleActiveSection,
      setSidePanelWidth,
      setActivityOrder,
      toggleChatSettings,
      fetchProviderMethods,
      configureProvider,
      newSession,
      switchSession,
      refreshSessions,
      newProject,
      openRecent,
      clearRecents,
      syncDiagrams,
      synthesizeCommitMessage,
      setCurrentSkill,
      answerQuestion,
      rejectQuestion
    }),
    [
      state,
      pickRoot,
      navigateRelative,
      navigateAbsolute,
      inspectFile,
      popTo,
      toast,
      reload,
      runScript,
      killScript,
      showOutput,
      hideOutput,
      toggleSidebar,
      setWorkspaceView,
      openCurrentFileInEditor,
      createCurrentExplanation,
      refreshTree,
      sendChat,
      setActiveSection,
      toggleActiveSection,
      setSidePanelWidth,
      setActivityOrder,
      toggleChatSettings,
      fetchProviderMethods,
      configureProvider,
      newSession,
      switchSession,
      refreshSessions,
      newProject,
      openRecent,
      clearRecents,
      syncDiagrams,
      synthesizeCommitMessage,
      setCurrentSkill,
      answerQuestion,
      rejectQuestion
    ]
  )

  return <StoreContext.Provider value={api}>{children}</StoreContext.Provider>
}
