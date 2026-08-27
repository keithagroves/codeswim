import type {
  GitHubSignInResult,
  GitHubStatus,
  MergeMethod,
  MergeResult,
  PullRequestList,
  RoomIdentity
} from '@codeswim/contract'
import type { CommandCtx } from './context'
import type { CommandRegistry } from './registry'

export interface GitHubRoomIdentityArgs {
  root: string
}

export interface GitHubListPullRequestsArgs {
  root: string
  filter?: 'open' | 'closed' | 'all'
}

export interface GitHubMergePullRequestArgs {
  root: string
  number: number
  method?: MergeMethod
}

export function registerGitHubCommands(registry: CommandRegistry): void {
  registry.register<GitHubRoomIdentityArgs, RoomIdentity | null>({
    id: 'github.roomIdentity',
    domain: 'github',
    title: 'Resolve room identity',
    description: "Derives this workspace's chat room identity from its git remote.",
    schema: { type: 'object', required: ['root'], properties: { root: { type: 'string' } } },
    agent: 'listed',
    run: (args, ctx: CommandCtx) => ctx.api.roomIdentity(args.root)
  })

  registry.register<Record<string, never>, GitHubStatus>({
    id: 'github.status',
    domain: 'github',
    title: 'GitHub auth status',
    description: 'Reads whether GitHub is configured and signed in.',
    schema: { type: 'object' },
    agent: 'listed',
    run: (_args, ctx) => ctx.api.githubStatus()
  })

  registry.register<Record<string, never>, string | null>({
    id: 'github.token',
    domain: 'github',
    title: 'GitHub access token',
    description: 'Reads the current GitHub access token, if signed in.',
    schema: { type: 'object' },
    // A live credential — never agent-reachable, and treated as sensitive
    // even for human callers (only the chat/PR panels read it).
    agent: 'never',
    run: (_args, ctx) => ctx.api.githubToken()
  })

  registry.register<Record<string, never>, GitHubSignInResult | { error: string }>({
    id: 'github.signIn',
    domain: 'github',
    title: 'Sign in to GitHub',
    description: 'Starts the GitHub device-flow sign-in.',
    schema: { type: 'object' },
    agent: 'never',
    run: (_args, ctx) => ctx.api.githubSignIn()
  })

  registry.register<Record<string, never>, void>({
    id: 'github.signOut',
    domain: 'github',
    title: 'Sign out of GitHub',
    description: 'Clears the stored GitHub credential.',
    schema: { type: 'object' },
    agent: 'never',
    run: (_args, ctx) => ctx.api.githubSignOut()
  })

  registry.register<GitHubListPullRequestsArgs, PullRequestList>({
    id: 'github.listPullRequests',
    domain: 'github',
    title: 'List pull requests',
    description: 'Lists pull requests for the workspace repository.',
    schema: {
      type: 'object',
      required: ['root'],
      properties: {
        root: { type: 'string' },
        filter: { type: 'string', enum: ['open', 'closed', 'all'], nullable: true }
      }
    },
    agent: 'listed',
    run: (args, ctx) => ctx.api.listPullRequests(args.root, args.filter)
  })

  registry.register<GitHubMergePullRequestArgs, MergeResult>({
    id: 'github.mergePullRequest',
    domain: 'github',
    title: 'Merge pull request',
    description: 'Merges a pull request.',
    schema: {
      type: 'object',
      required: ['root', 'number'],
      properties: {
        root: { type: 'string' },
        number: { type: 'number' },
        method: { type: 'string', enum: ['merge', 'squash', 'rebase'], nullable: true }
      }
    },
    // No danger gate: the merge row's own inline "confirming" step (pick a
    // merge method, click "Confirm merge") is already the human review —
    // same reasoning as git.commitPlan.
    agent: 'never',
    run: (args, ctx) => ctx.api.mergePullRequest(args.root, args.number, args.method)
  })
}
