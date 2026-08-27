// GitHub auth status + token, kept live via the main-process auth-change
// event stream. This is IPC event-subscription plumbing, not a workflow —
// see plans/command-bus-and-screen-context.md Phase 5 — so it stays a plain
// hook rather than a command, while the one-shot status/token reads
// underneath it go through commands/github.ts like everything else.
import { useEffect, useState } from 'react'
import type { GitHubStatus } from '@codeswim/contract'
import { useStore } from '../store'

export interface GitHubAuth {
  // null while the initial status fetch is still in flight.
  github: GitHubStatus | null
  // null when signed out (or before the token fetch resolves).
  token: string | null
}

export function useGitHubAuth(): GitHubAuth {
  const { githubAuthStatus, githubAccessToken } = useStore()
  const [github, setGithub] = useState<GitHubStatus | null>(null)
  const [token, setToken] = useState<string | null>(null)

  // Load status once and subscribe to sign-in/out changes (the device-flow
  // approval lands asynchronously, well after githubSignIn() returns).
  useEffect(() => {
    let cancelled = false
    void githubAuthStatus().then((s) => {
      if (!cancelled) setGithub(s)
    })
    const off = window.api.onGitHubAuthChanged((user) => {
      setGithub((prev) => ({ configured: prev?.configured ?? true, user }))
    })
    return () => {
      cancelled = true
      off()
    }
  }, [githubAuthStatus])

  const user = github?.user ?? null

  // Fetch the access token whenever we're signed in (and clear it on sign-out).
  useEffect(() => {
    if (!user) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setToken(null)
      return
    }
    let cancelled = false
    void githubAccessToken().then((t) => {
      if (!cancelled) setToken(t)
    })
    return () => {
      cancelled = true
    }
  }, [user, githubAccessToken])

  return { github, token }
}
