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
import { AGENT_STATE_FILE, formatAppState, validateOpenFilePath } from './tool/app-view'
import {
  defaultRoom,
  formatMessages,
  readChat,
  resolveChatConfig,
  sendChat,
  validateChatRoom,
  type ChatIo,
  type ChatRoom
} from './tool/chat'
import {
  findCommand,
  formatCommandList,
  resolveCommandConfig,
  runCommand,
  type CommandIo
} from './tool/command'
import { createSessionGate } from './session-gate'
import { readHooksConfig, runSessionStartHooks, type HooksIo } from './hooks'
import { exec as execCallback } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execCallback)

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

Use this to *show* the user something — a diagram, a doc, or a source file — rather than only describing it in chat. The path is a POSIX path relative to the workspace root. \`.md\` targets open as a diagram/doc; source files open with their companion explanation. This switches the app to the navigator tab automatically and is not gated. Returns a real result — if the path doesn't resolve, you'll see the error, not just an optimistic message.`

const FIND_COMMAND_DESCRIPTION = `Search the app's command registry for something you can invoke with run_command.

Covers the long tail of app actions beyond the tools listed here directly — e.g. switching the workspace tab, or stepping through navigation history. Returns matching command ids, titles, and argument shapes. Most everyday "show the user a file" requests should use open_file instead of searching for a nav command.`

const RUN_COMMAND_DESCRIPTION = `Invoke a command by id, typically one found via find_command.

Pass the command's id and an args object matching its schema. Returns the command's real result, or an error if the args are invalid or the command isn't available to agents — destructive or workspace-mutating commands stay human-only and will be rejected here regardless of id.`

const GET_APP_STATE_DESCRIPTION = `Read what the user is currently looking at in the app.

Returns the active tab (navigator vs. Kanban board), the open file and its view mode, the breadcrumb trail, and any running script. Call this when the user refers to "this" file/diagram/page or asks what's open. Not gated.`

const DESCRIPTION = `Create or replace a mermaid diagram file (\`.md\`) in the workspace.

Diagrams are the spec. Use this BEFORE writing code: code-mutating tools (\`write\`, \`edit\`, \`apply_patch\`) are gated on at least one prior \`diagram_edit\` call in the session.

Pass the full file contents — there is no patch mode. The file must contain YAML frontmatter (\`name\`, \`description\`, \`tags\`) and exactly one \`\`\`mermaid fenced block. Click handlers use \`click NodeId call navigate("./relative/path")\`. Targets ending in \`.md\` open as another diagram; source-file targets open their companion Markdown explanation.

Conventions: \`overview.md\` at workspace root; \`architecture/<name>.md\` per subsystem with a "Source" section; \`flows/<flow>.md\` for request flows; \`decisions/adr-<n>-<slug>.md\` for ADRs; source explanations at \`.codeswim/explanations/<source-path>.md\`.`

const KANBAN_DESCRIPTION = `Add a card to the project board (the Kanban view), persisted to \`.codeswim/board.json\`.

Use this to capture work the user describes — features, bugs, follow-ups, TODOs — so it shows up on the board instead of living only in chat. Users rarely add cards by hand; prefer creating one whenever a discrete unit of work is identified. The board view updates live.

Create one card per discrete task; break a large request into several cards rather than one sprawling card. \`status\` matches a column by name or id (defaults to the first column, usually Backlog). \`priority\` is low/medium/high (defaults to medium). \`linkedPath\` is a POSIX path relative to workspace root so the card deep-links into the navigator. This tool is not gated on diagram edits.`

const CHAT_READ_DESCRIPTION = `Read recent messages from this project's team chat (the in-app chat panel, not this conversation).

Two rooms exist for this repo: "public" (anyone, no sign-in) and "team" (GitHub collaborators only). Defaults to "team" when the user is signed in with GitHub, else "public". Use this to catch up on what teammates said, or to check whether someone already answered a question, before responding to the user.`

const CHAT_SEND_DESCRIPTION = `Post a message to this project's team chat (the in-app chat panel), visible to everyone else currently in the room.

Same two rooms as \`chat_read\`; same default. Posts under the agent's own display name so people can tell it's automated — this is not how you reply to the user, it's how you relay something to teammates who aren't in this conversation (e.g. a status update they asked for, or an answer to something asked in chat). Use sparingly.`

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

const chatIo: ChatIo = { fetch: (url, init) => fetch(url, init) }
const commandIo: CommandIo = { fetch: (url, init) => fetch(url, init) }

const realHooksIo: HooksIo = {
  readFile: (absPath) => fs.readFile(absPath, 'utf-8'),
  async exec(command, opts) {
    try {
      const { stdout } = await exec(command, { cwd: opts.cwd, timeout: opts.timeoutMs })
      return { code: 0, stdout }
    } catch (err) {
      const e = err as { code?: number | null; stdout?: string }
      return { code: e.code ?? 1, stdout: e.stdout ?? '' }
    }
  }
}

export const CodeswimPlugin: Plugin = async (input) => {
  const gate = createSessionGate()
  // Stable for the subprocess's lifetime — same lifetime/scoping rationale
  // as chatConfig/commandConfig below.
  const workspaceRoot = input.worktree
  // Resolved once per subprocess — the host (apps/desktop/src/main/sidecar.ts)
  // restarts the subprocess whenever the workspace root changes, so this env
  // is always scoped to the current workspace's room. null means this
  // workspace has no shared git remote to key a chat room on.
  const chatConfig = resolveChatConfig(process.env)
  // Same lifetime/scoping as chatConfig — resolved once per subprocess, and
  // null only if the host somehow started the sidecar without a command
  // bridge capability (main always issues one alongside every harness start,
  // so this is a defensive gate rather than an expected steady state).
  const commandConfig = resolveCommandConfig(process.env)

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

      ...(chatConfig
        ? {
            chat_read: tool({
              description: CHAT_READ_DESCRIPTION,
              args: {
                room: tool.schema
                  .enum(['public', 'team'])
                  .optional()
                  .describe('Which room to read — defaults to "team" when signed in, else "public"')
              },
              async execute(args) {
                const roomErr = args.room !== undefined ? validateChatRoom(args.room) : null
                if (roomErr) return { output: `error: ${roomErr}` }
                const room: ChatRoom = args.room ?? defaultRoom(chatConfig)

                const result = await readChat(room, chatConfig, chatIo)
                if (!result.ok) return { output: `error: ${result.error}` }
                return {
                  output: formatMessages(room, result.value),
                  metadata: { room, count: result.value.length }
                }
              }
            }),

            chat_send: tool({
              description: CHAT_SEND_DESCRIPTION,
              args: {
                room: tool.schema
                  .enum(['public', 'team'])
                  .optional()
                  .describe(
                    'Which room to post to — defaults to "team" when signed in, else "public"'
                  ),
                text: tool.schema.string().describe('Message text to post')
              },
              async execute(args) {
                const roomErr = args.room !== undefined ? validateChatRoom(args.room) : null
                if (roomErr) return { output: `error: ${roomErr}` }
                const room: ChatRoom = args.room ?? defaultRoom(chatConfig)

                const result = await sendChat(room, args.text, chatConfig, chatIo)
                if (!result.ok) return { output: `error: ${result.error}` }
                return {
                  output: `Posted to the ${room} room as ${result.value.name}.`,
                  metadata: { room, messageId: result.value.id }
                }
              }
            })
          }
        : {}),

      ...(commandConfig
        ? {
            open_file: tool({
              description: OPEN_FILE_DESCRIPTION,
              args: {
                file: tool.schema
                  .string()
                  .describe('POSIX path relative to workspace root to open in the navigator')
              },
              async execute(args, ctx) {
                const err = validateOpenFilePath(args.file)
                if (err) return { output: `error: ${err}` }
                const result = await runCommand(
                  'nav.navigateAbsolute',
                  { relPath: args.file, pushBreadcrumb: true },
                  ctx.sessionID,
                  ctx.worktree,
                  commandConfig,
                  commandIo
                )
                if (!result.ok) return { output: `error: ${result.error}` }
                return { output: `Opened ${args.file} in the navigator for the user.` }
              }
            }),

            find_command: tool({
              description: FIND_COMMAND_DESCRIPTION,
              args: {
                query: tool.schema
                  .string()
                  .describe('Search text — matched against command id, title, description, and domain')
              },
              async execute(args, ctx) {
                const result = await findCommand(
                  args.query,
                  ctx.sessionID,
                  ctx.worktree,
                  commandConfig,
                  commandIo
                )
                if (!result.ok) return { output: `error: ${result.error}` }
                return {
                  output: formatCommandList(result.value),
                  metadata: { count: result.value.length }
                }
              }
            }),

            run_command: tool({
              description: RUN_COMMAND_DESCRIPTION,
              args: {
                id: tool.schema.string().describe('Command id, e.g. "nav.setWorkspaceView"'),
                args: tool.schema
                  .record(tool.schema.string(), tool.schema.any())
                  .optional()
                  .describe("The command's args, matching the schema find_command returned for it")
              },
              async execute(args, ctx) {
                const result = await runCommand(
                  args.id,
                  args.args ?? {},
                  ctx.sessionID,
                  ctx.worktree,
                  commandConfig,
                  commandIo
                )
                if (!result.ok) return { output: `error: ${result.error}` }
                return { output: `Ran ${args.id}.`, metadata: { value: result.value } }
              }
            })
          }
        : {}),

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

    // Lets a user extend the bundled system prompt per-workspace via
    // .codeswim/hooks.json, without touching the packaged app. Re-read on
    // every call (cheap) so edits take effect on the next message.
    'experimental.chat.system.transform': async (_input, output) => {
      const config = await readHooksConfig(workspaceRoot, realHooksIo)
      const extra = await runSessionStartHooks(config, workspaceRoot, realHooksIo)
      output.system = [...output.system, ...extra]
    },

    // Surface the diagrams-first gate in the tool list so the model self-corrects
    // before attempting a blocked edit.
    'tool.definition': async (input, output) => {
      if (CODE_MUTATING_TOOLS.has(input.toolID)) output.description += GATE_NOTE
    }
  }
}

export default { server: CodeswimPlugin }
