---
"@getdomovoi/protocol": patch
"@getdomovoi/daemon": patch
"@getdomovoi/cli": patch
"@getdomovoi/credential-store": patch
"@getdomovoi/ui": patch
"@getdomovoi/web": patch
"@getdomovoi/desktop": patch
---

Update production dependencies. The daemon moves to Claude Agent SDK 0.3.281, Anthropic SDK 0.128.0,
Agent Client Protocol SDK 1.5.0, Kilo SDK 7.7.9, OpenCode SDK 1.18.32, MCP SDK 1.30.1 and yaml
2.9.1. Claude Agent SDK 0.3.281 is built against Claude Code 2.1.281, so the daemon now refuses an
older `claude` with "Update Claude Code to 2.1.281 or newer". The floor was 2.1.263. The keyring
binding moves to 2.1.0, zod to 4.6.5 and vite to 8.3.0. The shared ui and the web and desktop
clients move to Lucide 1.47.0 and tailwind-merge 3.7.0, and stay on React 19.2.8 and
react-resizable-panels 4.12.4: the newer two would put startup JavaScript over its budget. The
phone takes Expo 57.0.24 and stays on the React, safe-area and SVG versions that SDK bundles.
