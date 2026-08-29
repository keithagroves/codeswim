import { extname, parseTarget, resolveRelative } from '../path-utils'
import type { LineRange } from '../path-utils'
import type { WorkspaceView } from '../store'
import type { CommandCtx } from './context'
import { assertRelativeWorkspacePath } from './path-guard'
import type { CommandRegistry } from './registry'

interface ReadResult {
  contents: string
  view: 'diagram' | 'read' | 'code'
  documentPath: string
  sourceExplanationExists: boolean
  // Companion explanation prose, shown as a banner above the code in
  // CodeView. Null for markdown targets — they render their own content.
  explanationContent: string | null
}

// Shared by every nav command that lands on a file view: markdown reads raw
// (diagram/read), everything else is real source, shown in the code view
// with its companion explanation doc (if any) fetched alongside for the
// banner. Uses the root-scoped IPC (not the unrestricted absolute readFile)
// because this is reachable from the generic run_command path once the
// agent bridge lands — see plans/command-bus-and-screen-context.md Phase 2.
async function readFileSafe(
  ctx: CommandCtx,
  root: string,
  relPath: string,
  markdownView: 'diagram' | 'read' = 'diagram'
): Promise<ReadResult | null> {
  try {
    if (extname(relPath) === '.md') {
      const contents = await ctx.api.readWorkspaceFile(root, relPath)
      return {
        contents,
        view: markdownView,
        documentPath: relPath,
        sourceExplanationExists: true,
        explanationContent: null
      }
    }
    const [contents, explanation] = await Promise.all([
      ctx.api.readWorkspaceFile(root, relPath),
      ctx.api.readSourceExplanation(root, relPath)
    ])
    return {
      contents,
      view: 'code',
      documentPath: explanation.documentPath,
      sourceExplanationExists: explanation.exists,
      explanationContent: explanation.exists ? explanation.content : null
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.toast(`Could not read ${relPath}: ${msg}`, 'error')
    return null
  }
}

function requireRoot(ctx: CommandCtx): string | null {
  return ctx.executionRoot
}

export interface NavigateAbsoluteArgs {
  relPath: string
  pushBreadcrumb: boolean
  markdownView?: 'diagram' | 'read'
}

async function runNavigateAbsolute(args: NavigateAbsoluteArgs, ctx: CommandCtx): Promise<void> {
  const root = requireRoot(ctx)
  if (!root) return
  const { path, range } = parseTarget(args.relPath)
  ctx.dispatch({ type: 'set-loading', loading: true })
  const previous = ctx.getState().currentFile
  const result = await readFileSafe(ctx, root, path, args.markdownView)
  if (!result) {
    ctx.dispatch({ type: 'set-loading', loading: false })
    return
  }
  // A line ref only makes sense in source view — even for a markdown target
  // (e.g. `overview.md#L10-L22`), show its raw text rather than the diagram.
  const view = range ? 'code' : result.view
  ctx.dispatch({
    type: 'load-success',
    file: path,
    contents: result.contents,
    view,
    pushBreadcrumb: args.pushBreadcrumb,
    previous,
    revealNavigator: true,
    documentPath: result.documentPath,
    sourceExplanationExists: result.sourceExplanationExists,
    explanationContent: result.explanationContent,
    range
  })
}

export interface InspectFileArgs {
  relPath: string
}

export interface OpenSourceCodeArgs {
  relPath: string
  range: LineRange | null
}

async function runOpenSourceCode(args: OpenSourceCodeArgs, ctx: CommandCtx): Promise<void> {
  const root = requireRoot(ctx)
  if (!root) return
  ctx.dispatch({ type: 'set-loading', loading: true })
  const previous = ctx.getState().currentFile
  try {
    const [contents, explanation] = await Promise.all([
      ctx.api.readWorkspaceFile(root, args.relPath),
      extname(args.relPath) === '.md' ? null : ctx.api.readSourceExplanation(root, args.relPath)
    ])
    ctx.dispatch({
      type: 'load-success',
      file: args.relPath,
      contents,
      view: 'code',
      pushBreadcrumb: true,
      previous,
      revealNavigator: true,
      documentPath: explanation?.documentPath ?? args.relPath,
      sourceExplanationExists: explanation?.exists ?? false,
      explanationContent: explanation?.exists ? explanation.content : null,
      range: args.range
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.toast(`Could not open ${args.relPath}: ${msg}`, 'error')
    ctx.dispatch({ type: 'set-loading', loading: false })
  }
}

export interface NavigateRelativeArgs {
  target: string
}

// Resolves navigateRelative's target against whatever document is currently
// open. Returns null when there's nothing open to resolve against (run/
// validate both treat that as a no-op, matching the pre-command behavior).
// Re-attaches any `#L10-L22` line ref from the raw target onto the resolved
// path — runNavigateAbsolute re-parses it there — so a mermaid node's line
// reference survives being resolved relative to the current document.
function resolveTarget(args: NavigateRelativeArgs, ctx: CommandCtx): string | null {
  const state = ctx.getState()
  const baseFile = state.currentDocumentPath ?? state.currentFile
  if (!baseFile) return null
  const { path, range } = parseTarget(args.target)
  const resolved = resolveRelative(baseFile, path)
  if (!range) return resolved
  return `${resolved}#L${range.start}-L${range.end}`
}

// Reads a workspace file referenced relative to the currently open document,
// for the collapsible inline snippet preview in ReadView's rendered prose.
// Root-scoped (readWorkspaceFile), not the unrestricted absolute readFile —
// same reasoning as readFileSafe above.
export interface ReadSnippetArgs {
  target: string
}

async function runReadSnippet(args: ReadSnippetArgs, ctx: CommandCtx): Promise<string | null> {
  const root = requireRoot(ctx)
  if (!root) return null
  const resolved = resolveTarget(args, ctx)
  if (!resolved) return null
  try {
    return await ctx.api.readWorkspaceFile(root, resolved)
  } catch {
    return null
  }
}

export interface PopToArgs {
  index: number
}

async function runPopTo(args: PopToArgs, ctx: CommandCtx): Promise<void> {
  const root = requireRoot(ctx)
  if (!root) return
  const state = ctx.getState()
  const stack = state.breadcrumbs
  if (args.index < 0 || args.index >= stack.length) return
  const target = stack[args.index]
  const result = await readFileSafe(ctx, root, target)
  if (!result) return
  ctx.dispatch({
    type: 'pop-to',
    index: args.index,
    file: target,
    contents: result.contents,
    view: result.view,
    documentPath: result.documentPath,
    sourceExplanationExists: result.sourceExplanationExists,
    explanationContent: result.explanationContent
  })
}

async function runGoBack(_args: Record<string, never>, ctx: CommandCtx): Promise<void> {
  const root = requireRoot(ctx)
  if (!root) return
  const state = ctx.getState()
  const stack = state.breadcrumbs
  if (stack.length === 0) return
  const target = stack[stack.length - 1]
  const previous = state.currentFile
  const result = await readFileSafe(ctx, root, target)
  if (!result) return
  ctx.dispatch({
    type: 'nav-back',
    file: target,
    previous,
    contents: result.contents,
    view: result.view,
    documentPath: result.documentPath,
    sourceExplanationExists: result.sourceExplanationExists,
    explanationContent: result.explanationContent
  })
}

async function runGoForward(_args: Record<string, never>, ctx: CommandCtx): Promise<void> {
  const root = requireRoot(ctx)
  if (!root) return
  const state = ctx.getState()
  const stack = state.forward
  if (stack.length === 0) return
  const target = stack[stack.length - 1]
  const previous = state.currentFile
  const result = await readFileSafe(ctx, root, target)
  if (!result) return
  ctx.dispatch({
    type: 'nav-forward',
    file: target,
    previous,
    contents: result.contents,
    view: result.view,
    documentPath: result.documentPath,
    sourceExplanationExists: result.sourceExplanationExists,
    explanationContent: result.explanationContent
  })
}

export interface SetWorkspaceViewArgs {
  view: WorkspaceView
}

// Registers the navigation slice on `registry`. Called once per registry
// instance (StoreProvider). Kept as pure registration — no React, no
// StoreApi — so it's unit-testable against a bare CommandRegistry.
export function registerNavCommands(registry: CommandRegistry): void {
  registry.register<NavigateAbsoluteArgs, void>({
    id: 'nav.navigateAbsolute',
    domain: 'nav',
    title: 'Open file',
    description: 'Opens a workspace-relative file in the main panel.',
    schema: {
      type: 'object',
      required: ['relPath', 'pushBreadcrumb'],
      properties: {
        relPath: { type: 'string' },
        pushBreadcrumb: { type: 'boolean' },
        markdownView: { type: 'string', enum: ['diagram', 'read'], nullable: true }
      }
    },
    validate: (args) => assertRelativeWorkspacePath(parseTarget(args.relPath).path, 'relPath'),
    agent: 'listed',
    run: runNavigateAbsolute
  })

  registry.register<InspectFileArgs, void>({
    id: 'nav.inspectFile',
    domain: 'nav',
    title: 'Inspect file',
    description: "Opens a workspace-relative file's explanation view, pushing a breadcrumb.",
    schema: {
      type: 'object',
      required: ['relPath'],
      properties: { relPath: { type: 'string' } }
    },
    validate: (args) => assertRelativeWorkspacePath(parseTarget(args.relPath).path, 'relPath'),
    agent: 'listed',
    run: (args, ctx) =>
      runNavigateAbsolute(
        { relPath: args.relPath, pushBreadcrumb: true, markdownView: 'read' },
        ctx
      )
  })

  registry.register<OpenSourceCodeArgs, void>({
    id: 'nav.openSourceCode',
    domain: 'nav',
    title: 'Open source',
    description:
      'Opens a workspace-relative file as raw source, optionally scrolled to a line range.',
    schema: {
      type: 'object',
      required: ['relPath', 'range'],
      properties: {
        relPath: { type: 'string' },
        range: {
          type: 'object',
          nullable: true,
          required: ['start', 'end'],
          properties: { start: { type: 'number' }, end: { type: 'number' } }
        }
      }
    },
    validate: (args) => assertRelativeWorkspacePath(args.relPath, 'relPath'),
    agent: 'listed',
    run: runOpenSourceCode
  })

  registry.register<NavigateRelativeArgs, void>({
    id: 'nav.navigateRelative',
    domain: 'nav',
    title: 'Navigate relative',
    description: "Opens a file referenced relative to the currently open document's directory.",
    schema: {
      type: 'object',
      required: ['target'],
      properties: { target: { type: 'string' } }
    },
    validate: (args, ctx) => {
      const resolved = resolveTarget(args, ctx)
      // resolveRelative can walk above the workspace root (e.g. "../../x"
      // from a top-level file) — check the *resolved* path, not the raw
      // target, since a raw ".." is ordinary and expected here.
      if (resolved) assertRelativeWorkspacePath(resolved, 'target')
    },
    agent: 'listed',
    run: async (args, ctx) => {
      const resolved = resolveTarget(args, ctx)
      if (!resolved) return
      await runNavigateAbsolute({ relPath: resolved, pushBreadcrumb: true }, ctx)
    }
  })

  registry.register<ReadSnippetArgs, string | null>({
    id: 'nav.readSnippet',
    domain: 'nav',
    title: 'Read snippet',
    description:
      'Reads a workspace file referenced relative to the currently open document, for inline preview.',
    schema: {
      type: 'object',
      required: ['target'],
      properties: { target: { type: 'string' } }
    },
    validate: (args, ctx) => {
      const resolved = resolveTarget(args, ctx)
      if (resolved) assertRelativeWorkspacePath(resolved, 'target')
    },
    agent: 'listed',
    run: runReadSnippet
  })

  registry.register<PopToArgs, void>({
    id: 'nav.popTo',
    domain: 'nav',
    title: 'Pop to breadcrumb',
    description: 'Jumps back to a breadcrumb by its index in the current stack.',
    schema: {
      type: 'object',
      required: ['index'],
      properties: { index: { type: 'number' } }
    },
    agent: 'never',
    run: runPopTo
  })

  registry.register<Record<string, never>, void>({
    id: 'nav.goBack',
    domain: 'nav',
    title: 'Go back',
    description: 'Browser-style back navigation.',
    schema: { type: 'object' },
    agent: 'never',
    run: runGoBack
  })

  registry.register<Record<string, never>, void>({
    id: 'nav.goForward',
    domain: 'nav',
    title: 'Go forward',
    description: 'Browser-style forward navigation.',
    schema: { type: 'object' },
    agent: 'never',
    run: runGoForward
  })

  registry.register<SetWorkspaceViewArgs, void>({
    id: 'nav.setWorkspaceView',
    domain: 'nav',
    title: 'Switch workspace view',
    description: 'Switches the main workspace surface (navigator, kanban, agents).',
    schema: {
      type: 'object',
      required: ['view'],
      properties: { view: { type: 'string', enum: ['navigator', 'kanban', 'agents'] } }
    },
    agent: 'listed',
    run: async (args, ctx) => {
      ctx.dispatch({ type: 'set-workspace-view', view: args.view })
    }
  })
}
