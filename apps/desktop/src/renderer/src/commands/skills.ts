import type {
  AgentsDocContent,
  AgentsScope,
  LinkFolderResult,
  SkillFileContent,
  SkillFileNode,
  SkillListResult,
  SkillScope
} from '@codeswim/contract'
import type { CommandCtx } from './context'
import type { CommandRegistry } from './registry'

export interface SkillsListArgs {
  root: string | null
}

export interface SkillsListFilesArgs {
  scope: SkillScope
  name: string
  root: string | null
}

export interface SkillsReadFileArgs {
  scope: SkillScope
  name: string
  path: string
  root: string | null
}

export interface SkillsWriteFileArgs {
  scope: SkillScope
  name: string
  path: string
  content: string
  root: string | null
}

export interface SkillsReadAgentsDocArgs {
  scope: AgentsScope
  root: string | null
}

export interface SkillsWriteAgentsDocArgs {
  scope: AgentsScope
  content: string
  root: string | null
}

export interface SkillsCreateArgs {
  scope: 'global' | 'workspace'
  name: string
  template: string
  root: string | null
}

export interface SkillsDeleteArgs {
  scope: SkillScope
  name: string
  linkTarget?: string
  root: string | null
}

export interface SkillsLinkFolderArgs {
  scope: 'global' | 'workspace'
  source: string
  root: string | null
}

export interface SkillsOpenInEditorArgs {
  scope: SkillScope
  name: string
  root: string | null
  path?: string
}

export interface SkillsOpenAgentsDocInEditorArgs {
  scope: AgentsScope
  root: string | null
}

const NULLABLE_ROOT = { type: 'string', nullable: true } as const

export function registerSkillsCommands(registry: CommandRegistry): void {
  registry.register<SkillsListArgs, SkillListResult>({
    id: 'skills.list',
    domain: 'skills',
    title: 'List skills',
    description: 'Lists built-in, workspace, and global skills.',
    schema: { type: 'object', required: ['root'], properties: { root: NULLABLE_ROOT } },
    agent: 'listed',
    run: (args, ctx: CommandCtx) => ctx.api.listSkills(args.root)
  })

  registry.register<SkillsListFilesArgs, SkillFileNode[]>({
    id: 'skills.listFiles',
    domain: 'skills',
    title: 'List skill files',
    description: "Lists a skill's file tree.",
    schema: {
      type: 'object',
      required: ['scope', 'name', 'root'],
      properties: { scope: { type: 'string' }, name: { type: 'string' }, root: NULLABLE_ROOT }
    },
    agent: 'listed',
    run: (args, ctx) => ctx.api.listSkillFiles(args.scope, args.name, args.root)
  })

  registry.register<SkillsReadFileArgs, SkillFileContent>({
    id: 'skills.readFile',
    domain: 'skills',
    title: 'Read skill file',
    description: 'Reads a single file within a skill.',
    schema: {
      type: 'object',
      required: ['scope', 'name', 'path', 'root'],
      properties: {
        scope: { type: 'string' },
        name: { type: 'string' },
        path: { type: 'string' },
        root: NULLABLE_ROOT
      }
    },
    agent: 'listed',
    run: (args, ctx) => ctx.api.readSkillFile(args.scope, args.name, args.path, args.root)
  })

  registry.register<SkillsWriteFileArgs, void>({
    id: 'skills.writeFile',
    domain: 'skills',
    title: 'Write skill file',
    description: 'Writes a single file within a skill.',
    schema: {
      type: 'object',
      required: ['scope', 'name', 'path', 'content', 'root'],
      properties: {
        scope: { type: 'string' },
        name: { type: 'string' },
        path: { type: 'string' },
        content: { type: 'string' },
        root: NULLABLE_ROOT
      }
    },
    // Never agent-reachable: skills feed the agent's own system prompt, so
    // letting an agent rewrite one is a direct self-modification path.
    agent: 'never',
    run: (args, ctx) =>
      ctx.api.writeSkillFile(args.scope, args.name, args.path, args.content, args.root)
  })

  registry.register<SkillsReadAgentsDocArgs, AgentsDocContent>({
    id: 'skills.readAgentsDoc',
    domain: 'skills',
    title: 'Read AGENTS.md',
    description: 'Reads the workspace or global AGENTS.md.',
    schema: {
      type: 'object',
      required: ['scope', 'root'],
      properties: { scope: { type: 'string' }, root: NULLABLE_ROOT }
    },
    agent: 'listed',
    run: (args, ctx) => ctx.api.agentsDocRead(args.scope, args.root)
  })

  registry.register<SkillsWriteAgentsDocArgs, void>({
    id: 'skills.writeAgentsDoc',
    domain: 'skills',
    title: 'Write AGENTS.md',
    description: 'Writes the workspace or global AGENTS.md.',
    schema: {
      type: 'object',
      required: ['scope', 'content', 'root'],
      properties: { scope: { type: 'string' }, content: { type: 'string' }, root: NULLABLE_ROOT }
    },
    // Same reasoning as skills.writeFile: AGENTS.md is the agent's own
    // instruction file.
    agent: 'never',
    run: (args, ctx) => ctx.api.agentsDocWrite(args.scope, args.content, args.root)
  })

  registry.register<SkillsCreateArgs, void>({
    id: 'skills.create',
    domain: 'skills',
    title: 'Create skill',
    description: 'Creates a new skill from a starter template.',
    schema: {
      type: 'object',
      required: ['scope', 'name', 'template', 'root'],
      properties: {
        scope: { type: 'string' },
        name: { type: 'string' },
        template: { type: 'string' },
        root: NULLABLE_ROOT
      }
    },
    validate: (args) => {
      if (!/^[A-Za-z0-9._ -]+$/.test(args.name)) {
        throw new Error(
          'Skill name can only contain letters, digits, spaces, dots, dashes and underscores.'
        )
      }
      if (args.scope === 'workspace' && !args.root) {
        throw new Error('Open a folder before creating a workspace skill.')
      }
    },
    agent: 'never',
    run: (args, ctx) => ctx.api.writeSkill(args.scope, args.name, args.template, args.root)
  })

  registry.register<SkillsDeleteArgs, void>({
    id: 'skills.delete',
    domain: 'skills',
    title: 'Delete skill',
    description: 'Deletes (or unlinks) a skill folder.',
    schema: {
      type: 'object',
      required: ['scope', 'name', 'root'],
      properties: {
        scope: { type: 'string' },
        name: { type: 'string' },
        linkTarget: { type: 'string', nullable: true },
        root: NULLABLE_ROOT
      }
    },
    agent: 'never',
    danger: {
      kind: 'destructive',
      summarize: (args) =>
        args.linkTarget
          ? `Unlink "${args.name}" from this scope? The original at ${args.linkTarget} won't be touched.`
          : `Delete skill "${args.name}"? This removes the entire folder.`
    },
    run: (args, ctx) => ctx.api.deleteSkill(args.scope, args.name, args.root)
  })

  registry.register<SkillsLinkFolderArgs, LinkFolderResult>({
    id: 'skills.linkFolder',
    domain: 'skills',
    title: 'Link skill folder',
    description: 'Links a folder of SKILL.md trees into a scope.',
    schema: {
      type: 'object',
      required: ['scope', 'source', 'root'],
      properties: { scope: { type: 'string' }, source: { type: 'string' }, root: NULLABLE_ROOT }
    },
    validate: (args) => {
      if (args.scope === 'workspace' && !args.root) {
        throw new Error('Open a folder before linking workspace skills.')
      }
    },
    agent: 'never',
    run: (args, ctx) => ctx.api.linkSkillFolder(args.scope, args.source, args.root)
  })

  registry.register<SkillsOpenInEditorArgs, void>({
    id: 'skills.openInEditor',
    domain: 'skills',
    title: 'Open skill file in editor',
    description: "Opens a skill's file in the system's default editor.",
    schema: {
      type: 'object',
      required: ['scope', 'name', 'root'],
      properties: {
        scope: { type: 'string' },
        name: { type: 'string' },
        root: NULLABLE_ROOT,
        path: { type: 'string', nullable: true }
      }
    },
    agent: 'never',
    run: (args, ctx) => ctx.api.openSkillInEditor(args.scope, args.name, args.root, args.path)
  })

  registry.register<SkillsOpenAgentsDocInEditorArgs, void>({
    id: 'skills.openAgentsDocInEditor',
    domain: 'skills',
    title: 'Open AGENTS.md in editor',
    description: "Opens AGENTS.md in the system's default editor.",
    schema: {
      type: 'object',
      required: ['scope', 'root'],
      properties: { scope: { type: 'string' }, root: NULLABLE_ROOT }
    },
    agent: 'never',
    run: (args, ctx) => ctx.api.agentsDocOpenInEditor(args.scope, args.root)
  })
}
