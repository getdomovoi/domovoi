---
"@getdomovoi/daemon": patch
"@getdomovoi/desktop": patch
---

Run the person's own installed `claude` for Claude Code sessions. The daemon finds `claude` on the
tool PATH, the executable provider readiness already reports, and passes that path to the Claude
Agent SDK instead of letting the SDK start its own bundled agent binary. Without `claude`
installed, model discovery and new or resumed Claude Code sessions fail with "Claude Code is not
installed" and the SDK is never called.

The desktop app no longer packages the SDK's per-platform `@anthropic-ai/claude-agent-sdk-*`
packages, so it carries no copy of the agent binary and packaging never re-signs one. It still
bundles the SDK's JavaScript library, which the daemon imports.
