// Pull-request listing for the workspace's GitHub repository.
//
// Reuses the same two pieces of state the chat feature already relies on: the
// repo identity derived from the `origin` remote (room.ts) and the stored
// GitHub OAuth token (github-auth.ts). We only know how to talk to github.com,
// so non-GitHub remotes report `provider: 'git'` and the renderer shows a
// "not a GitHub repo" message instead of calling here.

import { getRoomIdentity } from './room'
import { getToken } from './github-auth'

const UA = 'codeswim'

export interface PullRequest {
  number: number
  title: string
  state: 'open' | 'closed'
  draft: boolean
  url: string
  author: string | null
  authorAvatarUrl: string | null
  createdAt: string
  updatedAt: string
  baseRef: string
  headRef: string
  comments: number
}

export interface PullRequestList {
  // 'ok' with the PRs, or a reason the list is empty/unavailable so the
  // renderer can show a precise message rather than a generic error.
  status: 'ok' | 'not-github' | 'no-auth' | 'error'
  slug: string | null
  pulls: PullRequest[]
  error?: string
}

export type MergeMethod = 'merge' | 'squash' | 'rebase'

export interface MergeResult {
  // 'merged' on success; 'no-auth' when we have no token to authorize the
  // write; 'not-github'/'error' mirror the list statuses. 'blocked' is GitHub
  // refusing the merge (not mergeable, checks failing, branch protection) —
  // distinct from a transport 'error' so the UI can word it as the PR's fault.
  status: 'merged' | 'blocked' | 'no-auth' | 'not-github' | 'error'
  message?: string
}

// Shape of the slice of the GitHub pulls API we read. Everything else on the
// payload is ignored.
interface GhPull {
  number: number
  title: string
  state: 'open' | 'closed'
  draft?: boolean
  html_url: string
  user: { login: string; avatar_url: string } | null
  created_at: string
  updated_at: string
  base: { ref: string }
  head: { ref: string }
  comments?: number
}

function toPullRequest(p: GhPull): PullRequest {
  return {
    number: p.number,
    title: p.title,
    state: p.state,
    draft: Boolean(p.draft),
    url: p.html_url,
    author: p.user?.login ?? null,
    authorAvatarUrl: p.user?.avatar_url ?? null,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    baseRef: p.base?.ref ?? '',
    headRef: p.head?.ref ?? '',
    comments: p.comments ?? 0
  }
}

// Resolve the workspace to a GitHub 'owner/repo' + the stored token, or null
// when the workspace has no github.com remote to key on.
interface ResolvedRepo {
  ownerRepo: string
  slug: string
  token: string | null
}
async function resolveRepo(rootPath: string): Promise<ResolvedRepo | null> {
  const identity = await getRoomIdentity(rootPath)
  if (!identity || identity.provider !== 'github') return null
  // slug is 'github.com/owner/repo'; strip the host to get the API path.
  const ownerRepo = identity.slug.replace(/^github\.com\//, '')
  const token = await getToken()
  return { ownerRepo, slug: identity.slug, token }
}

function ghHeaders(token: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': UA,
    'X-GitHub-Api-Version': '2022-11-28'
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

// List pull requests for the workspace repo. `state` mirrors the GitHub API
// ('open' | 'closed' | 'all'); we default to open since that's the working set.
export async function listPullRequests(
  rootPath: string,
  state: 'open' | 'closed' | 'all' = 'open'
): Promise<PullRequestList> {
  const repo = await resolveRepo(rootPath)
  if (!repo) {
    const identity = await getRoomIdentity(rootPath)
    return { status: 'not-github', slug: identity?.slug ?? null, pulls: [] }
  }
  const { ownerRepo, slug, token } = repo
  const headers = ghHeaders(token)

  const url =
    `https://api.github.com/repos/${ownerRepo}/pulls` +
    `?state=${state}&sort=updated&direction=desc&per_page=50`
  let res: Response
  try {
    res = await fetch(url, { headers })
  } catch (err) {
    return {
      status: 'error',
      slug,
      pulls: [],
      error: err instanceof Error ? err.message : String(err)
    }
  }

  if (res.status === 401 || res.status === 403) {
    // Private repo with no/insufficient token, or rate-limited without auth.
    return {
      status: token ? 'error' : 'no-auth',
      slug,
      pulls: [],
      error: token ? `GitHub returned ${res.status}` : undefined
    }
  }
  if (!res.ok) {
    return {
      status: 'error',
      slug,
      pulls: [],
      error: `GitHub returned ${res.status}`
    }
  }

  const data = (await res.json()) as GhPull[]
  return { status: 'ok', slug, pulls: data.map(toPullRequest) }
}

export interface PullRequestDiff {
  status: 'ok' | 'no-auth' | 'not-github' | 'error'
  diff: string
  message?: string
}

// Fetch a PR's unified diff. GitHub returns the raw diff when asked with the
// `.diff` media type on the pull endpoint. We fetch it in main (rather than
// leaning on the agent's shell) so the review works without `gh` configured.
export async function pullRequestDiff(rootPath: string, number: number): Promise<PullRequestDiff> {
  const repo = await resolveRepo(rootPath)
  if (!repo) return { status: 'not-github', diff: '' }
  const { ownerRepo, token } = repo

  const headers = ghHeaders(token)
  headers.Accept = 'application/vnd.github.v3.diff'

  const url = `https://api.github.com/repos/${ownerRepo}/pulls/${number}`
  let res: Response
  try {
    res = await fetch(url, { headers })
  } catch (err) {
    return { status: 'error', diff: '', message: err instanceof Error ? err.message : String(err) }
  }
  if (res.status === 401 || res.status === 403) {
    return { status: token ? 'error' : 'no-auth', diff: '' }
  }
  if (!res.ok) {
    return { status: 'error', diff: '', message: `GitHub returned ${res.status}` }
  }
  return { status: 'ok', diff: await res.text() }
}

// Merge a pull request via the GitHub API. Requires a token with write access
// to the repo. GitHub enforces mergeability (conflicts, required checks, branch
// protection) server-side; we surface its refusal as 'blocked' with the
// message it returns rather than guessing client-side.
export async function mergePullRequest(
  rootPath: string,
  number: number,
  method: MergeMethod = 'merge'
): Promise<MergeResult> {
  const repo = await resolveRepo(rootPath)
  if (!repo) return { status: 'not-github' }
  const { ownerRepo, token } = repo
  if (!token) return { status: 'no-auth' }

  const url = `https://api.github.com/repos/${ownerRepo}/pulls/${number}/merge`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ merge_method: method })
    })
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) }
  }

  // 200 = merged. GitHub returns the reason in `message` for the failure
  // codes: 405 not mergeable, 409 head moved, 403 forbidden.
  const body = (await res.json().catch(() => null)) as {
    merged?: boolean
    message?: string
  } | null

  if (res.ok && body?.merged) {
    return { status: 'merged', message: body.message }
  }
  if (res.status === 401 || res.status === 403) {
    return { status: 'no-auth', message: body?.message }
  }
  if (res.status === 405 || res.status === 409 || res.status === 422) {
    return { status: 'blocked', message: body?.message ?? `GitHub returned ${res.status}` }
  }
  return { status: 'error', message: body?.message ?? `GitHub returned ${res.status}` }
}
