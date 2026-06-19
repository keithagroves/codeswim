// Codeswim plugin for opencode.
//
// Registers a `diagram_edit` tool and gates code-mutating tools (`write`,
// `edit`, `apply_patch`) on at least one prior diagram edit per session.
// This is what makes the diagrams-first loop enforceable rather than
// suggested in the system prompt.
//
// Loaded by opencode at runtime via the `plugin` field in opencode's config.

import fs from 'node:fs/promises'
import path from 'node:path'
import { tool, type Plugin } from '@opencode-ai/plugin'
import { diagramEdit, validateContent, validatePath, type DiagramFs } from './tool/diagram-edit'
import { kanbanAdd, validateKanbanAdd, type KanbanFs } from './tool/kanban-add'
import {
  AGENT_STATE_FILE,
  formatAppState,
  validateOpenFilePath,
  validateViewName
} from './tool/app-view'
import { createSessionGate } from './session-gate'

const CODE_MUTATING_TOOLS = new Set(['write', 'edit', 'apply_patch'])

// Appended to the gated tools' descriptions so the model learns the rule from
// the tool list and calls `diagram_edit` proactively, instead of discovering
// the gate by eating a thrown error from `tool.execute.before` (a wasted turn
// every session). The `tool.definition` hook carries no session context, so
// this is necessarily static — but the rule itself is always true.
export const GATE_NOTE =
  '\n\nNote (codeswim): this tool is gated. It stays blocked until at least one ' +
  '`diagram_edit` call has happened in the current session — diagrams are the spec, ' +
  'so update the relevant diagram(s) first, then edit code.'

const OPEN_FILE_DESCRIPTION = `Open a file in the user's diagram navigator so they can see it.

Use this to *show* the user something — a diagram, a doc, or a source file — rather than only describing it in chat. The path is a POSIX path relative to the workspace root. \`.md\` targets open as a diagram/doc; source files open with their companion explanation. This switches the app to the navigator tab automatically and is not gated.`

const SET_VIEW_DESCRIPTION = `Switch the user's active workspace tab.

\`navigator\` shows the diagram/file navigator; \`kanban\` shows the project board. Use it when the user asks to see the board or get back to diagrams. Not gated.`

const GET_APP_STATE_DESCRIPTION = `Read what the user is currently looking at in the app.

Returns the active tab (navigator vs. Kanban board), the open file and its view mode, the breadcrumb trail, and any running script. Call this when the user refers to "this" file/diagram/page or asks what's open. Not gated.`

const DESCRIPTION = `Create or replace a mermaid diagram file (\`.md\`) in the workspace.

Diagrams are the spec. Use this BEFORE writing code: code-mutating tools (\`write\`, \`edit\`, \`apply_patch\`) are gated on at least one prior \`diagram_edit\` call in the session.

Pass the full file contents — there is no patch mode. The file must contain YAML frontmatter (\`name\`, \`description\`, \`tags\`) and exactly one \`\`\`mermaid fenced block. Click handlers use \`click NodeId call navigate("./relative/path")\`. Targets ending in \`.md\` open as another diagram; source-file targets open their companion Markdown explanation.

Conventions: \`overview.md\` at workspace root; \`architecture/<name>.md\` per subsystem with a "Source" section; \`flows/<flow>.md\` for request flows; \`decisions/adr-<n>-<slug>.md\` for ADRs; source explanations at \`.codeswim/explanations/<source-path>.md\`.`

const KANBAN_DESCRIPTION = `Add a card to the project board (the Kanban view), persisted to \`.codeswim/board.json\`.

Use this to capture work the user describes — features, bugs, follow-ups, TODOs — so it shows up on the board instead of living only in chat. Users rarely add cards by hand; prefer creating one whenever a discrete unit of work is identified. The board view updates live.

Create one card per discrete task; break a large request into several cards rather than one sprawling card. \`status\` matches a column by name or id (defaults to the first column, usually Backlog). \`priority\` is low/medium/high (defaults to medium). \`linkedPath\` is a POSIX path relative to workspace root so the card deep-links into the navigator. This tool is not gated on diagram edits.`

const realFs: DiagramFs = {
  async exists(absPath) {
    try {
      await fs.access(absPath)
      return true
    } catch {
      return false
    }
  },
  readFile(absPath) {
    return fs.readFile(absPath, 'utf-8')
  },
  async writeFile(absPath, content) {
    await fs.mkdir(path.dirname(absPath), { recursive: true })
    await fs.writeFile(absPath, content, 'utf-8')
  }
}

// Board lives at `<workspace>/.codeswim/board.json`; mirrors src/main/kanban.ts.
function kanbanFsFor(workspaceRoot: string): KanbanFs {
  const file = path.join(workspaceRoot, '.codeswim', 'board.json')
  return {
    async readBoard() {
      try {
        return await fs.readFile(file, 'utf-8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
      }
    },
    async writeBoard(json) {
      await fs.mkdir(path.dirname(file), { recursive: true })
      const temp = `${file}.tmp`
      await fs.writeFile(temp, json, 'utf-8')
      await fs.rename(temp, file)
    }
  }
}

export const CodeswimPlugin: Plugin = async () => {
  const gate = createSessionGate()

  return {
    tool: {
      diagram_edit: tool({
        description: DESCRIPTION,
        args: {
          file: tool.schema
            .string()
            .describe('POSIX path relative to workspace root, ending in .md'),
          content: tool.schema.string().describe('Full file contents (frontmatter + mermaid block)')
        },
        async execute(args, ctx) {
          const pathErr = validatePath(args.file)
          if (pathErr) return { output: `error: ${pathErr}` }
          const contentErr = validateContent(args.content)
          if (contentErr) return { output: `error: ${contentErr}` }

          const result = await diagramEdit(args, {
            workspaceRoot: ctx.worktree,
            fs: realFs,
            gate,
            sessionId: ctx.sessionID
          })
          return {
            output: `${result.kind === 'created' ? 'Created' : 'Replaced'} ${result.file}`,
            metadata: {
              kind: result.kind,
              file: result.file,
              before: result.before,
              after: result.after
            }
          }
        }
      }),

      kanban_add: tool({
        description: KANBAN_DESCRIPTION,
        args: {
          title: tool.schema.string().describe('Short imperative summary of the task'),
          description: tool.schema
            .string()
            .optional()
            .describe('Optional details, acceptance criteria, or context'),
          status: tool.schema
            .string()
            .optional()
            .describe('Target column by name or id (defaults to the first column)'),
          priority: tool.schema
            .enum(['low', 'medium', 'high'])
            .optional()
            .describe('Card priority (defaults to medium)'),
          labels: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe('Optional short tags, e.g. ["frontend", "bug"]'),
          linkedPath: tool.schema
            .string()
            .optional()
            .describe('POSIX path (relative to workspace root) of a related diagram/source file')
        },
        async execute(args, ctx) {
          const argErr = validateKanbanAdd(args)
          if (argErr) return { output: `error: ${argErr}` }

          const result = await kanbanAdd(args, {
            fs: kanbanFsFor(ctx.worktree),
            fallbackTitle: `${path.basename(ctx.worktree)} board`
          })
          return {
            output: `Added "${result.card.title}" to ${result.columnName}`,
            metadata: {
              cardId: result.card.id,
              title: result.card.title,
              columnName: result.columnName,
              priority: result.card.priority,
              linkedPath: result.card.linkedPath ?? null
            }
          }
        }
      }),

      open_file: tool({
        description: OPEN_FILE_DESCRIPTION,
        args: {
          file: tool.schema
            .string()
            .describe('POSIX path relative to workspace root to open in the navigator')
        },
        async execute(args) {
          const err = validateOpenFilePath(args.file)
          if (err) return { output: `error: ${err}` }
          return {
            output: `Opening ${args.file} in the navigator for the user.`,
            metadata: { codeswim_action: { type: 'open_file', path: args.file } }
          }
        }
      }),

      set_view: tool({
        description: SET_VIEW_DESCRIPTION,
        args: {
          view: tool.schema
            .enum(['navigator', 'kanban'])
            .describe('Which workspace tab to show')
        },
        async execute(args) {
          const err = validateViewName(args.view)
          if (err) return { output: `error: ${err}` }
          return {
            output: `Switching to the ${args.view === 'kanban' ? 'Kanban board' : 'diagram navigator'}.`,
            metadata: { codeswim_action: { type: 'set_view', view: args.view } }
          }
        }
      }),

      get_app_state: tool({
        description: GET_APP_STATE_DESCRIPTION,
        args: {},
        async execute(_args, ctx) {
          const file = path.join(ctx.worktree, ...AGENT_STATE_FILE.split('/'))
          let raw: string | null = null
          try {
            raw = await fs.readFile(file, 'utf-8')
          } catch {
            raw = null
          }
          return { output: formatAppState(raw) }
        }
      })
    },

    'tool.execute.before': async (input) => {
      if (!CODE_MUTATING_TOOLS.has(input.tool)) return
      const blocked = gate.checkCodeEditAllowed(input.sessionID)
      if (blocked) throw new Error(blocked)
    },

    // Surface the diagrams-first gate in the tool list so the model self-corrects
    // before attempting a blocked edit.
    'tool.definition': async (input, output) => {
      if (CODE_MUTATING_TOOLS.has(input.toolID)) output.description += GATE_NOTE
    }
  }
}

export default { server: CodeswimPlugin }
