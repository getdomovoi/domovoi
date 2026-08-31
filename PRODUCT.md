# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Stack

TypeScript monorepo with pnpm workspaces and strict TypeScript. React is shared by the Electron
desktop app and hosted browser/PWA client. UI uses Tailwind CSS v4, shadcn/ui, and Radix
primitives. The execution daemon runs on Node.js and communicates through WebSocket JSON-RPC.
Electron owns desktop integration; native mobile shells are a later delivery surface.

## Users

Domovoi initially serves one developer who runs AI coding agents across local machines, WSL
distributions, laptops, and remote development servers. They need to start work at a desk, review
it from a phone or tablet, and retain control over commands, diffs, previews, approvals, models,
cost, and credentials.

## Product Purpose

Domovoi is a local-first runner and control surface for AI coding agents. A headless daemon on
each execution machine owns repository state, worktrees, terminals, tools, provider credentials,
and sessions. Desktop, browser, phone, and tablet clients render and control the same daemon-owned
objects. Success means a session survives client changes, remains auditable, and can be reviewed
at full fidelity from any paired surface.

## Positioning

Domovoi combines a machine-fleet agent runner with first-class agent artifacts. Full-fidelity
plan and design previews, structured annotations, scoped approvals, model handoffs, and remote
clients are parts of one protocol rather than separate editor plugins or file-sync workflows.

## Operating Context

- Local Linux, macOS, and Windows development, including per-distribution WSL daemons.
- Remote machines reached over localhost, LAN, Tailscale, SSH, or an outbound relay.
- Subscription-backed provider CLIs first: Claude Code, Codex CLI, Cursor Agent, OpenCode, Grok,
  and Kilo; direct API adapters later.
- Git worktrees and checkpoints isolate build sessions and make consequential actions recoverable.
- Generated HTML plans and designs render in sandboxed preview surfaces and accept anchored review
  comments.
- External editors remain the code-editing surface; Domovoi is not a full IDE.

## Capabilities and Constraints

- Permission mode is Ask, Plan, or Build. Auto is a separate Build control. Hard gates always
  require explicit approval.
- Provider and model may change within a project. Native continuation is used where supported;
  otherwise Domovoi performs a checkpointed context handoff at a safe turn boundary.
- Code, credentials, PTYs, git state, and tool execution stay on the execution machine.
- The daemon is the source of truth. Clients consume ordered protocol events and do not invent
  private session state.
- Approval, annotation, and handoff decisions record their originating client.
- Mobile surfaces collapse information but do not omit decision facts.
- BYOK secrets live in the execution machine's OS keychain, never plaintext project config.
- Public packages must remain consumable through pnpm, npm, and Bun. Distribution should later
  support Homebrew, AUR, and Windows package managers.
- The public site design is unfinished and must not be implemented from the current prototype.
- Open decisions remain documented in `design/design_handoff_domovoi/OPEN-QUESTIONS.md`.

## Brand Commitments

The product name is Domovoi. The canonical domain is `domovoi.sh`; public source lives under the
GitHub organization `getdomovoi`, owned by `phetzy`; public JavaScript packages use the
`@getdomovoi` npm scope. The tagline is "A good spirit lives in your machines." Claude Design's
product and brand handoffs are the sole visual and verbal sources of truth. All general UI
primitives use shadcn/ui. Product copy states mechanisms and limits, uses plain punctuation, and
does not use the phrase "control plane."

## Evidence on Hand

- Signed-off cross-platform design contract and interactive prototypes:
  `design/design_handoff_domovoi/README.md`
- Signed-off brand identity, mark geometry, state family, and voice:
  `design/design_handoff_domovoi_brand/README.md`
- Reference screenshots for desktop, web, tablet, phone, and foundations:
  `design/design_handoff_domovoi/screenshots/`
- Deferred product decisions: `design/design_handoff_domovoi/OPEN-QUESTIONS.md`
- No customer claims, benchmarks, pricing, testimonials, or production usage evidence exists yet;
  future surfaces must not fabricate them.

## Product Principles

1. Execution stays with the machine that owns the code.
2. The daemon owns truth; every client sees the same ordered state.
3. Consequential actions are explicit, scoped, checkpointed, and attributed.
4. Review artifacts are first-class, full-fidelity objects—not chat attachments.
5. Cross-device adaptation collapses information without hiding safety facts.

## Accessibility & Inclusion

All controls must be keyboard-operable, status cannot rely on color alone, dialogs and overlays
must expose accessible names, and touch targets meet the platform floor: 44pt on iOS and 48dp on
Android. Reduced-motion and system-decoration fallbacks are supported.
