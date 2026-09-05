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
  mobile/    Expo phone app, see apps/mobile/README.md
  web/       browser client and installable PWA
packages/
  protocol/  publishable wire schemas and shared types
  ui/        shared product UI and brand assets
design/
  design_handoff_domovoi/        signed product-design source
  design_handoff_domovoi_brand/  signed brand source
```

## Develop

Requirements: Node.js 22.13.0 or newer and pnpm 11.

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
`DOMOVOI_ALLOW_REMOTE_TRANSPORT=1` plus `DOMOVOI_TLS_CERT_PATH` and `DOMOVOI_TLS_KEY_PATH`; the
daemon terminates TLS itself and refuses a plaintext non-loopback listener. Set
`DOMOVOI_ALLOWED_ORIGINS` to a comma-separated list of trusted browser origins. The browser client
dials `ws://127.0.0.1:47831/rpc` by default; set the build-time Vite variable
`VITE_DOMOVOI_RPC_URL`, read by `apps/web/src/main.tsx`, to point it at another daemon WebSocket
URL. Preview documents
on every listener, loopback included, require short-lived signed capabilities scoped to one
artifact revision, purpose, annotation bridge channel, and parent origin.

File-backed credentials are written, synced and closed in private staging before a no-replace
hard link publishes the final name. An interrupted first write therefore does not publish an
empty `daemon.token` or `local-owner.key`. Existing malformed files are preserved and startup
names their path; see [credential initialization and offline recovery](docs/credential-files.md)
before quarantining one. Initialization requires a filesystem with hard-link support.

For supervised operation, `domovoid service install` saves validated non-secret daemon settings and
uses them on every service start. Environment-only bearer tokens are not copied into service files.
See [daemon service configuration](docs/daemon-services.md) for credential setup and lifecycle limits.
For a stranded legacy or custom-supervised profile, `domovoid profile recover --confirm-no-supervisor`
records an explicit assertion that no supervisor will restart it. Stop those supervisors first.
The command requires a free profile lease; deleting `service.json` is not proof of shutdown.
See [local owner recovery](docs/local-daemon-ownership.md#service-installation-and-recovery) before using it.

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
The ranked delivery plan is tracked in [`ROADMAP.md`](ROADMAP.md). Agent-facing conventions and
the verified command set are summarized in [`AGENTS.md`](AGENTS.md).

## Licensing

Domovoi is open-core. This repository contains the Apache-2.0-licensed daemon, protocol, clients,
and local transports. The daemon's Claude Code session adapter depends at runtime on the
proprietary `@anthropic-ai/claude-agent-sdk`, installed from npm under Anthropic's terms rather
than redistributed here; that exception is recorded in [`docs/licensing.md`](docs/licensing.md).
Future hosted account, billing, relay, encrypted vault, and team-policy services may live outside
this repository.
