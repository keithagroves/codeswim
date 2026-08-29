import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useSyncExternalStore,
  type ReactNode
} from 'react'
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
import { buildCardPrompt } from './kanban-prompt'
import {
  buildCommitSynthesisPrompt,
  composeCommitBody,
  parseCommitMessage,
  type CommitMessage
} from '@codeswim/commit'
import { buildTriagePrompt, parseSyncPlan, type SyncPlan } from '@codeswim/commit'
import { extname, relativeToRoot, toPosix } from './path-utils'
import type {
  AgentsDocContent,
  AgentsScope,
  CommandOrigin,
  CommandOutcome,
  GitCommitEntry,
  GitHubSignInResult,
  GitHubStatus,
  GitInitResult,
  GitStatus,
  GitSyncResult,
  KanbanBoard,
  KanbanCard,
  KanbanWorktreeInfo,
  LinkFolderResult,
  MergeMethod,
  MergeResult,
  PullRequest,
  PullRequestList,
  RoomIdentity,
  SkillFileContent,
  SkillFileNode,
  SkillListResult,
  SkillScope
} from '@codeswim/contract'
import { CommandRegistry, CommandRegistryError } from './commands/registry'
import { registerNavCommands } from './commands/nav'
import type { GitSyncOutcome } from './commands/git'
import { registerKanbanCommands, type KanbanRunTracker } from './commands/kanban'
import { registerGitCommands } from './commands/git'
import { registerSkillsCommands } from './commands/skills'
import { registerHooksCommands } from './commands/hooks'
import { registerGitHubCommands } from './commands/github'
import type { CommandCtxFactory } from './commands/context'
import { SurfaceContextRegistry } from './context/surface-context'
import { composeScreenContext } from './context/compose-screen-context'
import {
  prDiffLabel,
  StoreContext,
  type AgentTab,
  type AppState,
  type ChatMessage,
  type ChatMessagePart,
  type ChatStatus,
  type FileView,
  type LineRange,
  type RunEntry,
  type RunningScript,
  type Section,
  type SessionInfo,
  type StoreApi,
  type Toast,
  type ToolsTab,
  type TreeNode,
  type View,
  type WorkspaceView
} from './store'

// Canonical section order + the single source of truth for which sections
// exist. Used for the default activity-bar order and to sanitize a stale
// saved order (drop unknowns, re-append any missing).
// Every StoreApi method that now delegates to the command registry is a
// human-initiated call; the agent reaches commands through its own bridge
// (Phase 2), never through these wrappers.
const HUMAN_ORIGIN: CommandOrigin = { kind: 'human' }

// The confirmation adapter for human-origin danger commands — the one place
// that decides how a human is asked to confirm. CommandRegistry/CommandCtx
// only depend on this function's signature (summary in, boolean out), so a
// future modal-based approval UI swaps in here without touching the
// registry or any command definition.
function humanConfirmAdapter(summary: string): Promise<boolean> {
  return Promise.resolve(window.confirm(summary))
}

const DEFAULT_ACTIVITY_ORDER: Section[] = [
  'agent',
  'files',
  'search',
  'coverage',
  'tools',
  'git',
  'pulls',
  'terminal',
  'claude',
  'chat'
]

const initialState: AppState = {
  rootPath: null,
  workspaceView: 'navigator',
  currentFile: null,
  currentDocumentPath: null,
  sourceExplanationExists: true,
  breadcrumbs: [],
  forward: [],
  view: 'diagram',
  fileContents: null,
  codeRange: null,
  loading: false,
  toasts: [],
  runs: [],
  runningScript: null,
  prevView: null,
  diffPath: null,
  diffContent: null,
  diffLoading: false,
  tree: null,
  activeSection: 'agent',
  lastActiveSection: 'agent',
  sidePanelWidth: 320,
  activityOrder: [...DEFAULT_ACTIVITY_ORDER],
  currentSkill: null,
  toolsTab: 'skills',
  chatStatus: 'idle',
  chatError: null,
  chatMessages: [],
  chatSettingsOpen: false,
  sessions: [],
  currentSessionId: null,
  recents: [],
  pendingQuestion: null,
  changeCount: 0,
  openPrCount: 0,
  agentTabs: [],
  activeAgentTabId: null
}

// Exported so commands/context.ts can type CommandCtx.dispatch precisely —
// the command layer dispatches these same actions, it just does so from
// commands/nav.ts instead of inline in this component.
export type Action =
  | { type: 'set-root'; rootPath: string }
  | { type: 'clear-root' }
  | {
      type: 'load-success'
      file: string
      contents: string
      view: FileView
      pushBreadcrumb: boolean
      previous: string | null
      revealNavigator: boolean
      documentPath: string
      sourceExplanationExists: boolean
      // Line range to highlight when view is 'code'. Any other navigation
      // (including revisiting a code file without a range) clears it.
      range?: LineRange | null
    }
  | {
      type: 'pop-to'
      index: number
      file: string
      contents: string
      view: FileView
      documentPath: string
      sourceExplanationExists: boolean
    }
  | {
      type: 'nav-back' | 'nav-forward'
      file: string
      // The file being left behind, moved onto the opposite stack.
      previous: string | null
      contents: string
      view: FileView
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
  | { type: 'show-diff'; path: string }
  | { type: 'set-diff-content'; path: string; content: string }
  | { type: 'hide-diff' }
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
        kind?: 'skill' | 'agents'
        scope: 'global' | 'workspace' | 'builtin'
        name: string
        linkTarget?: string
        file?: string
      } | null
    }
  | { type: 'set-tools-tab'; tab: ToolsTab }
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
  | { type: 'agent-tab-open'; tab: AgentTab }
  | { type: 'agent-tab-close'; tabId: string }
  | { type: 'agent-tab-activate'; tabId: string }
  // Replaces the whole tab strip wholesale — used to rehydrate tabs
  // persisted from a previous run of this workspace (see ensureAgent).
  | { type: 'agent-tabs-restore'; tabs: AgentTab[]; activeAgentTabId: string | null }
  | {
      type: 'agent-tab-patch'
      tabId: string
      patch: Partial<Pick<AgentTab, 'sessionId' | 'title' | 'status' | 'error' | 'messages'>>
    }
  | { type: 'agent-tab-add-message'; tabId: string; message: ChatMessage }
  // Routed by opencode session id (part updates arrive off the shared event
  // stream, which doesn't know about tabs). No-op when no tab matches.
  | {
      type: 'agent-tab-upsert-part'
      sessionId: string
      messageID: string
      part: ChatMessagePart & { id: string }
    }
  | { type: 'agent-tab-question'; sessionId: string; question: PendingQuestion }
  | { type: 'agent-tab-question-closed'; requestID: string }
  | { type: 'recents-set'; recents: string[] }
  | { type: 'set-change-count'; count: number }
  | { type: 'set-open-pr-count'; count: number }

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
        codeRange: action.range ?? null,
        breadcrumbs,
        // A fresh navigation branches the history — drop any forward trail.
        forward: [],
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
        codeRange: null,
        breadcrumbs,
        // Jumping to an arbitrary crumb isn't a single Back step; reset forward.
        forward: [],
        loading: false,
        prevView: null,
        workspaceView: 'navigator'
      }
    }
    case 'nav-back':
    case 'nav-forward': {
      // Back pops the breadcrumb stack and pushes the file we're leaving onto
      // forward; Forward does the mirror. `previous` is that left-behind file.
      const back = action.type === 'nav-back'
      const breadcrumbs = back
        ? state.breadcrumbs.slice(0, -1)
        : action.previous
          ? [...state.breadcrumbs, action.previous]
          : state.breadcrumbs
      const forward = back
        ? action.previous
          ? [...state.forward, action.previous]
          : state.forward
        : state.forward.slice(0, -1)
      return {
        ...state,
        currentFile: action.file,
        currentDocumentPath: action.documentPath,
        sourceExplanationExists: action.sourceExplanationExists,
        fileContents: action.contents,
        view: action.view,
        codeRange: null,
        breadcrumbs,
        forward,
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
    case 'show-diff': {
      // Remember the file view to return to (unless we're already showing a
      // transient view — output/diff — in which case keep the saved one).
      const transient = state.view === 'output' || state.view === 'diff'
      const prevView = transient ? state.prevView : (state.view as FileView)
      return {
        ...state,
        view: 'diff',
        prevView,
        diffPath: action.path,
        diffContent: null,
        diffLoading: true
      }
    }
    case 'set-diff-content': {
      // A newer request may have superseded this one; only apply if the path
      // still matches what the user is viewing.
      if (state.diffPath !== action.path) return state
      return { ...state, diffContent: action.content, diffLoading: false }
    }
    case 'hide-diff': {
      if (state.view !== 'diff') return state
      const target: View =
        state.prevView ?? (state.currentFile ? fileViewFor(state.currentFile) : 'diagram')
      return { ...state, view: target, prevView: null, diffPath: null, diffContent: null }
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
    case 'set-tools-tab':
      return { ...state, toolsTab: action.tab }
    case 'set-pending-question':
      return { ...state, pendingQuestion: action.question }
    case 'set-workspace-view': {
      // Switching tabs leaves any transient main-panel view (output/diff) and
      // lands back on a file view.
      const transient = state.view === 'output' || state.view === 'diff'
      const view = transient
        ? (state.prevView ?? (state.currentFile ? fileViewFor(state.currentFile) : 'diagram'))
        : state.view
      // The tools (skills/mcp) surface overrides the main panel; switching to a
      // workspace view has to leave it so the navigator/board actually shows.
      const activeSection = state.activeSection === 'tools' ? null : state.activeSection
      return {
        ...state,
        workspaceView: action.view,
        view,
        prevView: null,
        diffPath: null,
        activeSection
      }
    }
    case 'chat-status':
      return { ...state, chatStatus: action.status, chatError: action.error ?? null }
    case 'chat-add-message':
      return { ...state, chatMessages: [...state.chatMessages, action.message] }
    case 'chat-upsert-part': {
      const messages = state.chatMessages.slice()
      const msgIdx = messages.findIndex((m) => m.id === action.messageID)
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
    case 'agent-tab-open':
      return {
        ...state,
        agentTabs: [...state.agentTabs, action.tab],
        activeAgentTabId: action.tab.id
      }
    case 'agent-tab-close': {
      const idx = state.agentTabs.findIndex((t) => t.id === action.tabId)
      if (idx < 0) return state
      const agentTabs = state.agentTabs.filter((t) => t.id !== action.tabId)
      // Closing the active tab activates its right-hand neighbor (or the new
      // last tab), like a browser.
      let activeAgentTabId = state.activeAgentTabId
      if (activeAgentTabId === action.tabId) {
        activeAgentTabId = agentTabs[Math.min(idx, agentTabs.length - 1)]?.id ?? null
      }
      return { ...state, agentTabs, activeAgentTabId }
    }
    case 'agent-tab-activate':
      return { ...state, activeAgentTabId: action.tabId }
    case 'agent-tabs-restore':
      return { ...state, agentTabs: action.tabs, activeAgentTabId: action.activeAgentTabId }
    case 'agent-tab-patch':
      return {
        ...state,
        agentTabs: state.agentTabs.map((t) =>
          t.id === action.tabId ? { ...t, ...action.patch } : t
        )
      }
    case 'agent-tab-add-message':
      return {
        ...state,
        agentTabs: state.agentTabs.map((t) =>
          t.id === action.tabId ? { ...t, messages: [...t.messages, action.message] } : t
        )
      }
    case 'agent-tab-upsert-part':
      return {
        ...state,
        agentTabs: state.agentTabs.map((t) => {
          if (t.sessionId !== action.sessionId) return t
          const messages = t.messages.slice()
          const msgIdx = messages.findIndex((m) => m.id === action.messageID)
          if (msgIdx < 0) {
            messages.push({ id: action.messageID, role: 'assistant', parts: [action.part] })
            return { ...t, messages }
          }
          const msg = messages[msgIdx]
          const partIdx = msg.parts.findIndex((p) => 'id' in p && p.id === action.part.id)
          const nextParts = msg.parts.slice()
          if (partIdx < 0) nextParts.push(action.part)
          else nextParts[partIdx] = action.part
          messages[msgIdx] = { ...msg, parts: nextParts }
          return { ...t, messages }
        })
      }
    case 'agent-tab-question':
      return {
        ...state,
        agentTabs: state.agentTabs.map((t) =>
          t.sessionId === action.sessionId ? { ...t, pendingQuestion: action.question } : t
        )
      }
    case 'agent-tab-question-closed':
      return {
        ...state,
        agentTabs: state.agentTabs.map((t) =>
          t.pendingQuestion?.id === action.requestID ? { ...t, pendingQuestion: null } : t
        )
      }
    case 'recents-set':
      return { ...state, recents: action.recents }
    case 'set-change-count':
      return { ...state, changeCount: action.count }
    case 'set-open-pr-count':
      return { ...state, openPrCount: action.count }
    default:
      return state
  }
}

let toastSeq = 1
// Numbers new agent tabs ("Agent 1", "Agent 2", …) until opencode auto-titles
// the session from the first prompt.
let agentTabSeq = 1

export function StoreProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialState)
  const agentRef = useRef<AgentClient | null>(null)
  // rootPath for which the agentTabs persistence effect is safe to write.
  // `set-root` resets agentTabs to [] synchronously, well before ensureAgent
  // gets a chance to read the persisted tabs back — without this guard, the
  // write effect would see that transient empty array and delete the very
  // data ensureAgent is about to restore. Set once ensureAgent has read
  // (successfully or not) for a given rootPath.
  const agentTabsRestoredForRef = useRef<string | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  // Populated once startAgentInWorktree is declared below; buildCtx (built
  // above that declaration) reads through this ref rather than closing over
  // the useCallback result directly, matching stateRef's pattern.
  const startAgentInWorktreeRef = useRef<(card: KanbanCard, directory: string) => Promise<void>>(
    async () => {}
  )
  const planSyncRef = useRef<
    (diff: string, changedPaths: string[], instruction?: string) => Promise<SyncPlan>
  >(async () => {
    throw new Error('planSync not ready')
  })
  const commitGroupRef = useRef<
    (paths: string[], subject: string, body: string, dir?: string) => Promise<string>
  >(async () => {
    throw new Error('commitGroup not ready')
  })

  const toast = useCallback((message: string, kind: 'info' | 'error' = 'info') => {
    const id = toastSeq++
    dispatch({ type: 'add-toast', toast: { id, message, kind } })
    setTimeout(() => dispatch({ type: 'remove-toast', id }), 4000)
  }, [])

  // The command registry — one instance for the lifetime of this provider.
  // buildCtx reads stateRef/dispatch/toast at call time (all stable refs or
  // stable useCallback identities), so every command sees live state
  // regardless of when the registry itself was constructed.
  const commandsRef = useRef<CommandRegistry | null>(null)
  const kanbanRunTrackerRef = useRef<KanbanRunTracker | null>(null)
  if (!commandsRef.current) {
    const buildCtx: CommandCtxFactory = (origin) => ({
      getState: () => stateRef.current,
      dispatch,
      api: window.api,
      toast,
      origin,
      activeRoot: stateRef.current.rootPath,
      executionRoot: origin.kind === 'agent' ? origin.worktree : stateRef.current.rootPath,
      confirm: async (_danger, summary) => {
        // Agent-origin dangerous commands are denied by default — a real
        // scoped-grant approval service is the UX follow-up (plans/
        // command-bus-and-screen-context.md Phase 4). This half (fail-closed
        // enforcement, independent of opencode's own permission: 'allow')
        // ships now; only the approval UX is deferred.
        if (origin.kind === 'agent') return false
        return humanConfirmAdapter(summary)
      },
      startAgentInWorktree: (card, directory) => startAgentInWorktreeRef.current(card, directory),
      planSync: (diff, changedPaths, instruction) =>
        planSyncRef.current(diff, changedPaths, instruction),
      commitGroup: (paths, subject, body, dir) => commitGroupRef.current(paths, subject, body, dir)
    })
    const registry = new CommandRegistry(buildCtx)
    registerNavCommands(registry)
    kanbanRunTrackerRef.current = registerKanbanCommands(registry)
    registerGitCommands(registry)
    registerSkillsCommands(registry)
    registerHooksCommands(registry)
    registerGitHubCommands(registry)
    commandsRef.current = registry
  }
  const commands = commandsRef.current
  const kanbanRunTracker = kanbanRunTrackerRef.current as KanbanRunTracker

  // Registry of context blocks contributed by mounted surfaces (see
  // useSurfaceContext) — one instance for the provider's lifetime, same
  // pattern as commandsRef above.
  const surfaceContextRef = useRef<SurfaceContextRegistry | null>(null)
  if (!surfaceContextRef.current) {
    surfaceContextRef.current = new SurfaceContextRegistry()
  }
  const surfaceContext = surfaceContextRef.current
  const surfaceBlocks = useSyncExternalStore(surfaceContext.subscribe, surfaceContext.getSnapshot)
  const kanbanRunningCardIds = useSyncExternalStore(
    kanbanRunTracker.subscribe,
    kanbanRunTracker.getSnapshot
  )

  // A block keyed by e.g. a card id belongs to the workspace that produced
  // it — meaningless (and potentially misleading) once the root changes.
  useEffect(() => {
    surfaceContext.clear()
  }, [state.rootPath, surfaceContext])

  // Answers main's 'command:request' events (the harness's find_command/
  // run_command/open_file tools, proxied over IPC by
  // main/command-server.ts) by running them against this same registry with
  // an agent origin, then replying with the real outcome. One subscription
  // for the provider's lifetime — command requests are workspace-agnostic at
  // this layer; executionRoot is derived per-call from the request's own
  // origin.worktree, not from whatever root happens to be open right now.
  useEffect(() => {
    const unsubscribe = window.api.onCommandRequest((request) => {
      void (async () => {
        if (request.kind === 'find') {
          await window.api.replyCommand({
            id: request.id,
            kind: 'find',
            commands: commands.find(request.query)
          })
          return
        }
        try {
          const value = await commands.run(request.commandId, request.args, request.origin)
          await window.api.replyCommand({
            id: request.id,
            kind: 'run',
            outcome: { ok: true, value }
          })
        } catch (err) {
          const outcome: CommandOutcome =
            err instanceof CommandRegistryError
              ? { ok: false, code: err.code, message: err.message }
              : {
                  ok: false,
                  code: 'handler-error',
                  message: err instanceof Error ? err.message : String(err)
                }
          await window.api.replyCommand({ id: request.id, kind: 'run', outcome })
        }
      })()
    })
    return unsubscribe
  }, [commands])

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
        // Route to any Agents-view tab bound to this session; the reducer
        // no-ops when nothing matches.
        const tabbed = stateRef.current.agentTabs.some((t) => t.sessionId === sessionID)
        if (tabbed) {
          dispatch({ type: 'agent-tab-upsert-part', sessionId: sessionID, messageID, part })
        }
        if (sessionID !== stateRef.current.currentSessionId) return
        dispatch({ type: 'chat-upsert-part', messageID, part })
      })

      // Forward question events for the current session. We only ever
      // render one prompt at a time — opencode shouldn't fire concurrent
      // questions for a single session in practice.
      agent.subscribeQuestions((event) => {
        if (event.kind === 'asked') {
          if (stateRef.current.agentTabs.some((t) => t.sessionId === event.question.sessionID)) {
            dispatch({
              type: 'agent-tab-question',
              sessionId: event.question.sessionID,
              question: event.question
            })
          }
          if (event.question.sessionID !== stateRef.current.currentSessionId) return
          dispatch({ type: 'set-pending-question', question: event.question })
        } else {
          dispatch({ type: 'agent-tab-question-closed', requestID: event.requestID })
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

      // Restore Agents-view tabs left over from a previous run of this
      // workspace. Only id/sessionId/title were persisted (to
      // .codeswim/agent-tabs.json via the main process — not localStorage,
      // whose writes aren't reliably flushed before the app exits) — history
      // itself lives in opencode, so each tab with a session is rehydrated
      // via loadMessages below. The hydration loop below is fire-and-forget:
      // the tab strip shows up immediately (empty/"connecting"), and the
      // main session above isn't held up waiting on it.
      const persisted = await window.api.agentTabsRead(rootPath).catch(() => null)
      agentTabsRestoredForRef.current = rootPath
      if (persisted) {
        const restoredTabs: AgentTab[] = persisted.tabs.map((t) => ({
          id: t.id,
          sessionId: t.sessionId,
          title: t.title,
          status: t.sessionId ? 'connecting' : 'idle',
          error: null,
          messages: [],
          pendingQuestion: null,
          directory: t.directory ?? null
        }))
        dispatch({
          type: 'agent-tabs-restore',
          tabs: restoredTabs,
          activeAgentTabId: persisted.activeAgentTabId
        })
        // Keep new tabs' default "Agent N" title from colliding with a
        // restored one.
        for (const t of restoredTabs) {
          const m = /^Agent (\d+)$/.exec(t.title)
          if (m) agentTabSeq = Math.max(agentTabSeq, Number(m[1]) + 1)
        }

        for (const t of restoredTabs) {
          if (!t.sessionId) continue
          const sessionId = t.sessionId
          void agent
            .loadMessages(sessionId, t.directory ?? undefined)
            .then((messages) => {
              dispatch({
                type: 'agent-tab-patch',
                tabId: t.id,
                patch: { messages: toChatMessages(messages), status: 'ready' }
              })
            })
            .catch(() => {
              dispatch({
                type: 'agent-tab-patch',
                tabId: t.id,
                patch: { status: 'error', error: "Couldn't load this session's history." }
              })
            })
        }
      }

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
        dispatch({ type: 'agent-tab-question-closed', requestID })
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
        dispatch({ type: 'agent-tab-question-closed', requestID })
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

  // --- Agents view (browser-style tabs, one opencode session per tab) ---

  const openAgentTab = useCallback((opts?: { directory?: string; title?: string }): string => {
    const n = agentTabSeq++
    const id = `tab-${Date.now()}-${n}`
    const tab: AgentTab = {
      id,
      sessionId: null,
      title: opts?.title || `Agent ${n}`,
      status: 'idle',
      error: null,
      messages: [],
      pendingQuestion: null,
      directory: opts?.directory ?? null
    }
    // Patch stateRef synchronously, ahead of the dispatch taking effect.
    // Callers that open a tab and immediately send to it in the same tick
    // (Kanban's "Start in background"/"Run all", which don't wait for a
    // render between the two) would otherwise have sendAgentChat's
    // `stateRef.current.agentTabs.find(...)` miss the brand-new tab and
    // silently no-op — the tab would open but never actually receive its
    // prompt.
    stateRef.current = {
      ...stateRef.current,
      agentTabs: [...stateRef.current.agentTabs, tab],
      activeAgentTabId: id
    }
    dispatch({ type: 'agent-tab-open', tab })
    return id
  }, [])

  const closeAgentTab = useCallback((tabId: string) => {
    dispatch({ type: 'agent-tab-close', tabId })
  }, [])

  const activateAgentTab = useCallback((tabId: string) => {
    dispatch({ type: 'agent-tab-activate', tabId })
  }, [])

  const sendAgentChat = useCallback(
    async (tabId: string, text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      const root = stateRef.current.rootPath
      if (!root) {
        toast('Open a folder before chatting with the agent.', 'error')
        return
      }
      const agent = await ensureAgent(root)
      if (!agent) return
      const tab = stateRef.current.agentTabs.find((t) => t.id === tabId)
      if (!tab) return
      // Worktree-scoped tabs (Kanban "Run all") point their session at an
      // isolated git worktree instead of rootPath.
      const directory = tab.directory ?? root

      const patch = (
        p: Partial<Pick<AgentTab, 'sessionId' | 'title' | 'status' | 'error'>>
      ): void => dispatch({ type: 'agent-tab-patch', tabId, patch: p })

      try {
        // Sessions are created lazily so an unused tab leaves no history.
        let sessionId = tab.sessionId
        if (!sessionId) {
          patch({ status: 'connecting' })
          const created = await agent.createSession(directory)
          sessionId = created.id
          patch({ sessionId })
        }

        const userMsgId = `u-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        dispatch({
          type: 'agent-tab-add-message',
          tabId,
          message: { id: userMsgId, role: 'user', parts: [{ kind: 'text', text: trimmed }] }
        })
        patch({ status: 'thinking', error: null })

        const reply = await agent.send(sessionId, trimmed, directory)
        for (const part of reply.parts) {
          dispatch({ type: 'agent-tab-upsert-part', sessionId, messageID: reply.messageID, part })
        }
        patch({ status: 'ready' })

        // opencode auto-titles the session from the first prompt; adopt it as
        // the tab title once available. Skipped for worktree-scoped tabs —
        // they already carry the card's title, which is more useful than
        // whatever opencode derives from the synthesized prompt text.
        if (tab.directory) return
        void agent.listSessions().then((sessions) => {
          dispatch({ type: 'sessions-set', sessions })
          const info = sessions.find((s) => s.id === sessionId)
          if (info?.title) {
            dispatch({ type: 'agent-tab-patch', tabId, patch: { title: info.title } })
          }
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        patch({ status: 'error', error: msg })
        toast(`Agent error: ${msg}`, 'error')
      }
    },
    [ensureAgent, toast]
  )

  // Kanban "Start" button: opens a fresh agent tab, switches to the Agents
  // view so it's immediately visible, and sends the card as the first
  // message. Fire-and-forget from the caller's perspective — sendAgentChat
  // reports its own errors via toast.
  const startAgentFromCard = useCallback(
    (card: KanbanCard) => {
      const tabId = openAgentTab()
      dispatch({ type: 'set-workspace-view', view: 'agents' })
      void sendAgentChat(tabId, buildCardPrompt(card))
    },
    [openAgentTab, sendAgentChat]
  )

  // Kanban "Run all": same as startAgentFromCard, but scoped to an isolated
  // git worktree and deliberately doesn't touch workspaceView — the whole
  // point is to keep running while the user stays wherever they were. Awaits
  // the first reply so the caller (the run-all scheduler) can sequence cards
  // that depend on this one.
  const startAgentInWorktree = useCallback(
    async (card: KanbanCard, directory: string): Promise<void> => {
      const tabId = openAgentTab({ directory, title: card.title })
      await sendAgentChat(tabId, buildCardPrompt(card))
    },
    [openAgentTab, sendAgentChat]
  )
  startAgentInWorktreeRef.current = startAgentInWorktree

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
        kind?: 'skill' | 'agents'
        scope: 'global' | 'workspace' | 'builtin'
        name: string
        linkTarget?: string
        file?: string
      } | null
    ) => dispatch({ type: 'set-current-skill', skill }),
    []
  )
  const setToolsTab = useCallback((tab: ToolsTab) => dispatch({ type: 'set-tools-tab', tab }), [])
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

  // Still used directly by `reload` below, which re-reads the current file
  // in place rather than navigating — not part of the nav.* command slice.
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

  // Navigation is now the command registry's nav.* commands
  // (commands/nav.ts); these are thin delegating wrappers kept for every
  // existing caller (StoreApi consumers, applyViewAction) so no component
  // changes were required to land the registry.
  const navigateAbsolute = useCallback(
    (relPath: string, pushBreadcrumb: boolean, markdownView?: 'diagram' | 'read') =>
      commands.run<void>(
        'nav.navigateAbsolute',
        { relPath, pushBreadcrumb, markdownView },
        HUMAN_ORIGIN
      ),
    [commands]
  )

  const inspectFile = useCallback(
    (relPath: string): Promise<void> =>
      commands.run<void>('nav.inspectFile', { relPath }, HUMAN_ORIGIN),
    [commands]
  )

  const openSourceCode = useCallback(
    (relPath: string, range: LineRange | null): Promise<void> =>
      commands.run<void>('nav.openSourceCode', { relPath, range }, HUMAN_ORIGIN),
    [commands]
  )

  const navigateRelative = useCallback(
    (target: string): Promise<void> =>
      commands.run<void>('nav.navigateRelative', { target }, HUMAN_ORIGIN),
    [commands]
  )

  // ReadView's inline collapsible-snippet preview — reads a workspace file
  // referenced relative to the currently open document, without navigating.
  const readSnippet = useCallback(
    (target: string): Promise<string | null> =>
      commands.run<string | null>('nav.readSnippet', { target }, HUMAN_ORIGIN),
    [commands]
  )

  const popTo = useCallback(
    (index: number): Promise<void> => commands.run<void>('nav.popTo', { index }, HUMAN_ORIGIN),
    [commands]
  )

  const goBack = useCallback(
    (): Promise<void> => commands.run<void>('nav.goBack', {}, HUMAN_ORIGIN),
    [commands]
  )

  const goForward = useCallback(
    (): Promise<void> => commands.run<void>('nav.goForward', {}, HUMAN_ORIGIN),
    [commands]
  )

  // KanbanView's workflows are now the command registry's kanban.* commands
  // (commands/kanban.ts); these are thin delegating wrappers, same pattern
  // as the nav.* ones above.
  const kanbanLoad = useCallback(
    (root: string): Promise<KanbanBoard | null> =>
      commands.run<KanbanBoard | null>('kanban.load', { root }, HUMAN_ORIGIN),
    [commands]
  )

  const kanbanSave = useCallback(
    (board: KanbanBoard): Promise<KanbanBoard | null> =>
      commands.run<KanbanBoard | null>('kanban.save', { board }, HUMAN_ORIGIN),
    [commands]
  )

  const kanbanGitHubSync = useCallback(
    (board: KanbanBoard): Promise<KanbanBoard | null> =>
      commands.run<KanbanBoard | null>('kanban.githubSync', { board }, HUMAN_ORIGIN),
    [commands]
  )

  const kanbanMoveCard = useCallback(
    (
      board: KanbanBoard,
      cardId: string,
      columnId: string,
      beforeCardId?: string
    ): Promise<KanbanBoard | null> =>
      commands.run<KanbanBoard | null>(
        'kanban.moveCard',
        { board, cardId, columnId, beforeCardId },
        HUMAN_ORIGIN
      ),
    [commands]
  )

  const kanbanEnsureRepo = useCallback(
    (): Promise<boolean> => commands.run<boolean>('kanban.ensureRepo', {}, HUMAN_ORIGIN),
    [commands]
  )

  const kanbanRunCard = useCallback(
    (cardId: string, sourceColumnId: string): Promise<void> =>
      commands.run<void>('kanban.runCard', { cardId, sourceColumnId }, HUMAN_ORIGIN),
    [commands]
  )

  const kanbanRunColumn = useCallback(
    (columnId: string): Promise<void> =>
      commands.run<void>('kanban.runColumn', { columnId }, HUMAN_ORIGIN),
    [commands]
  )

  // GitPanel's workflows are now the command registry's git.* commands
  // (commands/git.ts); these are thin delegating wrappers, same pattern as
  // the nav.*/kanban.* ones above.
  const kanbanListWorktrees = useCallback(
    (root: string): Promise<KanbanWorktreeInfo[]> =>
      commands.run<KanbanWorktreeInfo[]>('kanban.listWorktrees', { root }, HUMAN_ORIGIN),
    [commands]
  )

  const gitRefreshStatus = useCallback(
    (dir: string): Promise<GitStatus> =>
      commands.run<GitStatus>('git.refreshStatus', { dir }, HUMAN_ORIGIN),
    [commands]
  )

  const gitLoadHistory = useCallback(
    (dir: string, limit: number): Promise<GitCommitEntry[]> =>
      commands.run<GitCommitEntry[]>('git.loadHistory', { dir, limit }, HUMAN_ORIGIN),
    [commands]
  )

  const gitInitRepo = useCallback(
    (root: string): Promise<GitInitResult> =>
      commands.run<GitInitResult>('git.init', { root }, HUMAN_ORIGIN),
    [commands]
  )

  const gitSync = useCallback(
    (dir: string, isCardTarget: boolean, instruction?: string): Promise<GitSyncOutcome> =>
      commands.run<GitSyncOutcome>('git.sync', { dir, isCardTarget, instruction }, HUMAN_ORIGIN),
    [commands]
  )

  const gitCommitPlan = useCallback(
    (
      dir: string,
      plan: SyncPlan
    ): Promise<{ commits: Array<{ subject: string; sha: string }>; sync: GitSyncResult }> =>
      commands.run('git.commitPlan', { dir, plan }, HUMAN_ORIGIN),
    [commands]
  )

  // SkillsPanel/SkillsView's workflows are now the command registry's
  // skills.* commands (commands/skills.ts); these are thin delegating
  // wrappers, same pattern as the nav.*/kanban.*/git.* ones above.
  const skillsList = useCallback(
    (root: string | null): Promise<SkillListResult> =>
      commands.run<SkillListResult>('skills.list', { root }, HUMAN_ORIGIN),
    [commands]
  )

  const skillsListFiles = useCallback(
    (scope: SkillScope, name: string, root: string | null): Promise<SkillFileNode[]> =>
      commands.run<SkillFileNode[]>('skills.listFiles', { scope, name, root }, HUMAN_ORIGIN),
    [commands]
  )

  const skillsReadFile = useCallback(
    (
      scope: SkillScope,
      name: string,
      path: string,
      root: string | null
    ): Promise<SkillFileContent> =>
      commands.run<SkillFileContent>('skills.readFile', { scope, name, path, root }, HUMAN_ORIGIN),
    [commands]
  )

  const skillsWriteFile = useCallback(
    (
      scope: SkillScope,
      name: string,
      path: string,
      content: string,
      root: string | null
    ): Promise<void> =>
      commands.run<void>('skills.writeFile', { scope, name, path, content, root }, HUMAN_ORIGIN),
    [commands]
  )

  const skillsReadAgentsDoc = useCallback(
    (scope: AgentsScope, root: string | null): Promise<AgentsDocContent> =>
      commands.run<AgentsDocContent>('skills.readAgentsDoc', { scope, root }, HUMAN_ORIGIN),
    [commands]
  )

  const skillsWriteAgentsDoc = useCallback(
    (scope: AgentsScope, content: string, root: string | null): Promise<void> =>
      commands.run<void>('skills.writeAgentsDoc', { scope, content, root }, HUMAN_ORIGIN),
    [commands]
  )

  const skillsCreate = useCallback(
    (
      scope: 'global' | 'workspace',
      name: string,
      template: string,
      root: string | null
    ): Promise<void> =>
      commands.run<void>('skills.create', { scope, name, template, root }, HUMAN_ORIGIN),
    [commands]
  )

  const skillsDelete = useCallback(
    (
      scope: SkillScope,
      name: string,
      linkTarget: string | undefined,
      root: string | null
    ): Promise<void> =>
      commands.run<void>('skills.delete', { scope, name, linkTarget, root }, HUMAN_ORIGIN),
    [commands]
  )

  const skillsLinkFolder = useCallback(
    (
      scope: 'global' | 'workspace',
      source: string,
      root: string | null
    ): Promise<LinkFolderResult> =>
      commands.run<LinkFolderResult>('skills.linkFolder', { scope, source, root }, HUMAN_ORIGIN),
    [commands]
  )

  const skillsOpenInEditor = useCallback(
    (scope: SkillScope, name: string, root: string | null, path?: string): Promise<void> =>
      commands.run<void>('skills.openInEditor', { scope, name, root, path }, HUMAN_ORIGIN),
    [commands]
  )

  const skillsOpenAgentsDocInEditor = useCallback(
    (scope: AgentsScope, root: string | null): Promise<void> =>
      commands.run<void>('skills.openAgentsDocInEditor', { scope, root }, HUMAN_ORIGIN),
    [commands]
  )

  const hooksRead = useCallback(
    (root: string | null): Promise<AgentsDocContent> =>
      commands.run<AgentsDocContent>('hooks.read', { root }, HUMAN_ORIGIN),
    [commands]
  )

  const hooksWrite = useCallback(
    (root: string | null, content: string): Promise<void> =>
      commands.run<void>('hooks.write', { content, root }, HUMAN_ORIGIN),
    [commands]
  )

  const hooksOpenInEditor = useCallback(
    (root: string | null): Promise<void> =>
      commands.run<void>('hooks.openInEditor', { root }, HUMAN_ORIGIN),
    [commands]
  )

  // RoomChatPanel/PullRequestsPanel's workflows are now the command
  // registry's github.* commands (commands/github.ts); these are thin
  // delegating wrappers, same pattern as the nav.*/kanban.*/git.*/skills.*
  // ones above.
  const githubRoomIdentity = useCallback(
    (root: string): Promise<RoomIdentity | null> =>
      commands.run<RoomIdentity | null>('github.roomIdentity', { root }, HUMAN_ORIGIN),
    [commands]
  )

  const githubAuthStatus = useCallback(
    (): Promise<GitHubStatus> => commands.run<GitHubStatus>('github.status', {}, HUMAN_ORIGIN),
    [commands]
  )

  const githubAccessToken = useCallback(
    (): Promise<string | null> => commands.run<string | null>('github.token', {}, HUMAN_ORIGIN),
    [commands]
  )

  const githubSignIn = useCallback(
    (): Promise<GitHubSignInResult | { error: string }> =>
      commands.run<GitHubSignInResult | { error: string }>('github.signIn', {}, HUMAN_ORIGIN),
    [commands]
  )

  const githubSignOut = useCallback(
    (): Promise<void> => commands.run<void>('github.signOut', {}, HUMAN_ORIGIN),
    [commands]
  )

  const githubListPullRequests = useCallback(
    (root: string, filter?: 'open' | 'closed' | 'all'): Promise<PullRequestList> =>
      commands.run<PullRequestList>('github.listPullRequests', { root, filter }, HUMAN_ORIGIN),
    [commands]
  )

  const githubMergePullRequest = useCallback(
    (root: string, number: number, method?: MergeMethod): Promise<MergeResult> =>
      commands.run<MergeResult>('github.mergePullRequest', { root, number, method }, HUMAN_ORIGIN),
    [commands]
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

  // Activity-bar badge counts. Fetched here (not in the panels) so the numbers
  // show even when the matching panel has never been opened — the panels only
  // mount while active. The change count is unique changed paths across git's
  // staged/unstaged/untracked split, matching GitPanel's flattened list.
  const refreshChangeCount = useCallback(async () => {
    const root = stateRef.current.rootPath
    if (!root) return
    try {
      const s = await window.api.gitStatus(root)
      const paths = new Set<string>()
      if (s.isRepo) {
        for (const f of s.unstaged) paths.add(f.path)
        for (const f of s.staged) paths.add(f.path)
        for (const p of s.untracked) paths.add(p)
      }
      dispatch({ type: 'set-change-count', count: paths.size })
    } catch {
      dispatch({ type: 'set-change-count', count: 0 })
    }
  }, [])

  const refreshOpenPrCount = useCallback(async () => {
    const root = stateRef.current.rootPath
    if (!root) return
    try {
      const res = await window.api.listPullRequests(root, 'open')
      dispatch({ type: 'set-open-pr-count', count: res.status === 'ok' ? res.pulls.length : 0 })
    } catch {
      dispatch({ type: 'set-open-pr-count', count: 0 })
    }
  }, [])

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

  const openDemo = useCallback(async () => {
    try {
      const path = await window.api.openDemo()
      await openWorkspace(path)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast(`Could not open the demo: ${msg}`, 'error')
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

  const reviewPullRequest = useCallback(
    async (pr: {
      number: number
      title: string
      author: string | null
      baseRef: string
      headRef: string
      url: string
    }) => {
      const root = stateRef.current.rootPath
      if (!root) {
        toast('Open a folder first.', 'error')
        return
      }
      // Pull the diff in main so the review works even without `gh` set up. If
      // it's unavailable we still send the prompt and tell the agent to fetch
      // it. Very large diffs are capped so the prompt stays manageable.
      let diffBlock: string
      try {
        const result = await window.api.pullRequestDiff(root, pr.number)
        if (result.status === 'ok' && result.diff.trim()) {
          const MAX = 120_000
          const truncated = result.diff.length > MAX
          const body = truncated ? result.diff.slice(0, MAX) : result.diff
          diffBlock = `Here is the unified diff${
            truncated ? ' (truncated — fetch the rest with `gh pr diff` if you need it)' : ''
          }:\n\n\`\`\`diff\n${body}\n\`\`\``
        } else {
          diffBlock = `I couldn't fetch the diff automatically. Use \`gh pr diff ${pr.number}\` or git to inspect the changes at ${pr.url}.`
        }
      } catch {
        diffBlock = `I couldn't fetch the diff automatically. Use \`gh pr diff ${pr.number}\` or git to inspect the changes at ${pr.url}.`
      }

      dispatch({ type: 'set-active-section', section: 'agent' })
      await sendChat(`Review pull request #${pr.number} — "${pr.title}"${
        pr.author ? ` by ${pr.author}` : ''
      } (\`${pr.headRef}\` → \`${pr.baseRef}\`).

${diffBlock}

Inspect the changes for correctness bugs, security issues, and whether they keep the project's diagrams aligned with the code. Call out specific problems with file references and concrete fixes; if it looks good, say so briefly. This is a review only — don't edit any files.`)
    },
    [sendChat, toast]
  )

  const showPullRequestDiff = useCallback(async (pr: PullRequest): Promise<void> => {
    const root = stateRef.current.rootPath
    if (!root) return
    // Reuse the main-panel diff viewer (the same one git file diffs use). The
    // label doubles as the dedup key: the reducer drops stale results whose
    // path no longer matches, so rapid PR clicks resolve to the last one.
    const label = prDiffLabel(pr)
    dispatch({ type: 'show-diff', path: label })
    try {
      const result = await window.api.pullRequestDiff(root, pr.number)
      const content =
        result.status === 'ok'
          ? result.diff
          : result.status === 'no-auth'
            ? 'Sign in to GitHub to view this pull request’s diff.'
            : result.status === 'not-github'
              ? 'This workspace isn’t connected to a GitHub repository.'
              : `Could not load the diff:\n${result.message ?? 'unknown error'}`
      dispatch({ type: 'set-diff-content', path: label, content })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      dispatch({
        type: 'set-diff-content',
        path: label,
        content: `Could not load the diff:\n${msg}`
      })
    }
  }, [])

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

  const planSync = useCallback(
    async (diff: string, changedPaths: string[], instruction?: string): Promise<SyncPlan> => {
      const root = stateRef.current.rootPath
      if (!root) throw new Error('Open a folder first.')
      const agent = await ensureAgent(root)
      if (!agent) throw new Error('Agent is not connected — configure a provider first.')
      // Ephemeral session, same as commit synthesis: triage must never show up
      // in the chat the user reads.
      const session = await agent.createSession()
      const reply = await agent.send(session.id, buildTriagePrompt(diff, changedPaths, instruction))
      const text = reply.parts
        .filter((p) => p.kind === 'text' && p.text)
        .map((p) => p.text as string)
        .join('')
        .trim()
      if (!text) throw new Error('The agent returned an empty response.')
      return parseSyncPlan(text, changedPaths)
    },
    [ensureAgent]
  )
  planSyncRef.current = planSync

  const commitGroup = useCallback(
    async (paths: string[], subject: string, body: string, dir?: string): Promise<string> => {
      const target = dir ?? stateRef.current.rootPath
      if (!target) throw new Error('Open a folder first.')
      const fullBody = composeCommitBody(body, { coveragePassed: true })
      return window.api.gitCommitGroup(target, paths, subject, fullBody)
    },
    []
  )
  commitGroupRef.current = commitGroup

  const addToGitignore = useCallback(async (patterns: string[], dir?: string) => {
    const target = dir ?? stateRef.current.rootPath
    if (!target) throw new Error('Open a folder first.')
    return window.api.gitAddToGitignore(target, patterns)
  }, [])

  const showFileDiff = useCallback(async (path: string, dir?: string): Promise<void> => {
    const root = dir ?? stateRef.current.rootPath
    if (!root) return
    // Switch the main panel to the diff view immediately (loading), then fill it
    // in once git returns. The reducer ignores stale results whose path no
    // longer matches, so rapid clicks resolve to the last one selected.
    dispatch({ type: 'show-diff', path })
    try {
      const content = await window.api.gitFileDiff(root, path)
      dispatch({ type: 'set-diff-content', path, content })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      dispatch({ type: 'set-diff-content', path, content: `Could not load the diff:\n${msg}` })
    }
  }, [])

  const hideDiff = useCallback(() => dispatch({ type: 'hide-diff' }), [])

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
    (view: WorkspaceView) => {
      void commands.run<void>('nav.setWorkspaceView', { view }, HUMAN_ORIGIN)
    },
    [commands]
  )

  // Publish a versioned snapshot of what the user is looking at so the
  // agent's get_app_state tool can read it — reducer state plus whatever
  // surface blocks are currently registered (composeScreenContext). Debounced;
  // best-effort. Re-fires on either state or surfaceBlocks changing, since a
  // component-local block (a mermaid render error, an open kanban card) can
  // change without any reducer action at all.
  useEffect(() => {
    const { rootPath } = state
    if (!rootPath) return
    const context = composeScreenContext(state, surfaceBlocks)
    const id = setTimeout(() => {
      void window.api.publishAgentState(rootPath, context).catch(() => {
        // best-effort; the tool degrades gracefully when the file is absent
      })
    }, 150)
    return () => clearTimeout(id)
  }, [
    state.rootPath,
    state.workspaceView,
    state.currentFile,
    state.currentDocumentPath,
    state.view,
    state.diffPath,
    state.diffContent,
    state.activeSection,
    state.activeAgentTabId,
    state.breadcrumbs,
    state.runningScript,
    surfaceBlocks
  ])

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

  // Keep the activity-bar badges current. Fetch both counts when the workspace
  // opens, then re-count working-tree changes on any file or tree change
  // (debounced — editors write in bursts). Open-PR count only changes from the
  // server side, so it's fetched once here and again after a merge.
  useEffect(() => {
    if (!state.rootPath) return
    void refreshChangeCount()
    void refreshOpenPrCount()
    let timer: ReturnType<typeof setTimeout> | null = null
    const scheduleCount = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void refreshChangeCount(), 250)
    }
    const unsubFile = window.api.onFileChanged(scheduleCount)
    const unsubTree = window.api.onTreeChanged(scheduleCount)
    return () => {
      if (timer) clearTimeout(timer)
      unsubFile()
      unsubTree()
    }
  }, [state.rootPath, refreshChangeCount, refreshOpenPrCount])

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
          // Migrate the legacy 'skills' section key to 'tools'.
          const migrated = parsed.map((k) => (k === 'skills' ? 'tools' : k))
          dispatch({ type: 'set-activity-order', order: migrated })
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

  // Persist the Agents-view tab strip (id/sessionId/title only — see
  // PersistedAgentTabs in @codeswim/contract) to .codeswim/agent-tabs.json
  // via the main process, so it survives a restart. Keyed off a lightweight
  // signature rather than `state.agentTabs` directly so a token streaming in
  // mid-conversation doesn't trigger a write on every delta.
  const agentTabsSignature = useMemo(
    () =>
      state.agentTabs
        .map((t) => `${t.id}:${t.sessionId ?? ''}:${t.title}:${t.directory ?? ''}`)
        .join('|'),
    [state.agentTabs]
  )
  useEffect(() => {
    if (!state.rootPath) return
    // Guards against the transient empty agentTabs a `set-root` reset
    // produces before ensureAgent has had a chance to restore — see the
    // comment on agentTabsRestoredForRef above.
    if (agentTabsRestoredForRef.current !== state.rootPath) return
    void window.api
      .agentTabsWrite(state.rootPath, {
        tabs: state.agentTabs.map((t) => ({
          id: t.id,
          sessionId: t.sessionId,
          title: t.title,
          directory: t.directory
        })),
        activeAgentTabId: state.activeAgentTabId
      })
      .catch(() => {
        // best-effort — a failed write just means tabs won't restore next time
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.rootPath, agentTabsSignature, state.activeAgentTabId])

  const api = useMemo<StoreApi>(
    () => ({
      state,
      commands,
      surfaceContext,
      pickRoot,
      navigateRelative,
      readSnippet,
      navigateAbsolute,
      inspectFile,
      openSourceCode,
      popTo,
      goBack,
      goForward,
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
      openDemo,
      openRecent,
      clearRecents,
      syncDiagrams,
      synthesizeCommitMessage,
      planSync,
      commitGroup,
      addToGitignore,
      showFileDiff,
      hideDiff,
      reviewPullRequest,
      showPullRequestDiff,
      refreshOpenPrCount,
      setCurrentSkill,
      setToolsTab,
      answerQuestion,
      rejectQuestion,
      openAgentTab,
      closeAgentTab,
      activateAgentTab,
      sendAgentChat,
      startAgentFromCard,
      startAgentInWorktree,
      kanbanRunningCardIds,
      kanbanLoad,
      kanbanSave,
      kanbanGitHubSync,
      kanbanMoveCard,
      kanbanEnsureRepo,
      kanbanRunCard,
      kanbanRunColumn,
      kanbanListWorktrees,
      gitRefreshStatus,
      gitLoadHistory,
      gitInitRepo,
      gitSync,
      gitCommitPlan,
      skillsList,
      skillsListFiles,
      skillsReadFile,
      skillsWriteFile,
      skillsReadAgentsDoc,
      skillsWriteAgentsDoc,
      skillsCreate,
      skillsDelete,
      skillsLinkFolder,
      skillsOpenInEditor,
      skillsOpenAgentsDocInEditor,
      hooksRead,
      hooksWrite,
      hooksOpenInEditor,
      githubRoomIdentity,
      githubAuthStatus,
      githubAccessToken,
      githubSignIn,
      githubSignOut,
      githubListPullRequests,
      githubMergePullRequest
    }),
    [
      state,
      commands,
      surfaceContext,
      pickRoot,
      navigateRelative,
      readSnippet,
      navigateAbsolute,
      inspectFile,
      openSourceCode,
      popTo,
      goBack,
      goForward,
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
      openDemo,
      openRecent,
      clearRecents,
      syncDiagrams,
      synthesizeCommitMessage,
      planSync,
      commitGroup,
      addToGitignore,
      showFileDiff,
      hideDiff,
      reviewPullRequest,
      showPullRequestDiff,
      refreshOpenPrCount,
      setCurrentSkill,
      setToolsTab,
      answerQuestion,
      rejectQuestion,
      openAgentTab,
      closeAgentTab,
      activateAgentTab,
      sendAgentChat,
      startAgentFromCard,
      startAgentInWorktree,
      kanbanRunningCardIds,
      kanbanLoad,
      kanbanSave,
      kanbanGitHubSync,
      kanbanMoveCard,
      kanbanEnsureRepo,
      kanbanRunCard,
      kanbanRunColumn,
      kanbanListWorktrees,
      gitRefreshStatus,
      gitLoadHistory,
      gitInitRepo,
      gitSync,
      gitCommitPlan,
      skillsList,
      skillsListFiles,
      skillsReadFile,
      skillsWriteFile,
      skillsReadAgentsDoc,
      skillsWriteAgentsDoc,
      skillsCreate,
      skillsDelete,
      skillsLinkFolder,
      skillsOpenInEditor,
      skillsOpenAgentsDocInEditor,
      hooksRead,
      hooksWrite,
      hooksOpenInEditor,
      githubRoomIdentity,
      githubAuthStatus,
      githubAccessToken,
      githubSignIn,
      githubSignOut,
      githubListPullRequests,
      githubMergePullRequest
    ]
  )

  return <StoreContext.Provider value={api}>{children}</StoreContext.Provider>
}
