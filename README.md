# Domovoi

A local-first runner for AI coding agents across your machines.

Domovoi puts a daemon beside the code and renders its sessions in desktop and browser clients.
Repository state, credentials, terminals, worktrees, and tool execution stay on the execution
machine. Clients receive typed state, diffs, terminal streams, approval requests, and sandboxed
preview documents.

This repository is early. The current vertical slice includes:

- strict TypeScript and pnpm workspaces;
- a versioned Zod protocol with permission, runtime, machine, session, approval, thread, and
  artifact schemas;
- an authenticated Node daemon with health and WebSocket JSON-RPC endpoints;
- a shared React workspace rendered by Vite and Electron;
- custom Electron window decoration with a sandboxed, context-isolated renderer;
- daemon-backed approval and runtime state changes;
- Claude Design's signed desktop layout and Domovoi spirit mark implemented with Tailwind v4,
  shadcn/ui, and Radix.

## Workspace

```text
apps/
  daemon/    domovoid execution service and JSON-RPC endpoint
  desktop/   Electron client
  web/       browser client and future PWA
packages/
  protocol/  publishable wire schemas and shared types
  ui/        shared product UI and brand assets
design/
  design_handoff_domovoi/        signed product-design source
  design_handoff_domovoi_brand/  signed brand source
```

## Develop

Requirements: Node.js 22 or newer and pnpm 11.

```bash
pnpm install
pnpm build
pnpm dev
```

`pnpm dev` starts `domovoid` on `127.0.0.1:47831` and the browser client on
`127.0.0.1:5178`. Run the Electron shell separately:

```bash
pnpm dev:desktop
```

Every daemon requires authentication. Standalone `domovoid` creates a user-private credential at
`~/.domovoi/daemon.token` when `DOMOVOI_AUTH_TOKEN` is unset. Remote listeners additionally require
`DOMOVOI_ALLOW_REMOTE_TRANSPORT=1`. The opt-in is only for an encrypted outer transport such as a
Tailscale tailnet or SSH tunnel; the daemon does not provide TLS itself. Set
`DOMOVOI_ALLOWED_ORIGINS` to a comma-separated list of trusted browser origins. Remote preview
documents use short-lived capabilities scoped to one artifact and annotation bridge channel.

## Verify

```bash
pnpm typecheck
pnpm test
pnpm build
```

Alpha performance limits and the local/CI budget command are documented in
[`docs/performance-budgets.md`](docs/performance-budgets.md).

## Architecture rules

- Daemon owns canonical session state.
- Code and secrets stay on the execution machine.
- Ask, Plan, and Build are permission modes. Auto is a separate control.
- Hard gates require explicit approval.
- Cross-provider handoffs carry documented Domovoi state, not hidden provider reasoning or caches.
- Clients collapse information for smaller screens; they do not omit approval facts.
- Preview documents execute only inside sandboxed artifact containers.

Open product decisions are tracked in
[`design/design_handoff_domovoi/OPEN-QUESTIONS.md`](design/design_handoff_domovoi/OPEN-QUESTIONS.md).
The ranked delivery plan is tracked in [`ROADMAP.md`](ROADMAP.md).

## Licensing

Domovoi is open-core. This repository contains the Apache-2.0-licensed daemon, protocol, clients,
and local transports. Future hosted account, billing, relay, encrypted vault, and team-policy
services may live outside this repository.
