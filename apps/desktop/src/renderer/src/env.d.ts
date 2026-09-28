/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PARTY_HOST?: string
  // '1' shows Anthropic's Claude Spark on the Claude Code tab — local-only,
  // see ClaudeIcon in components/ActivityBar.tsx.
  readonly VITE_CLAUDE_BRAND_ICON?: string
}
