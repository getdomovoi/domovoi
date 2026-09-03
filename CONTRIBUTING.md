# Contributing to Domovoi

Domovoi is an early open-core project. This repository contains the Apache-2.0-licensed daemon,
protocol, desktop and web clients, shared UI, and local transports. Contributions to those parts
are welcome.

## Before starting

- Search existing issues and pull requests before opening a duplicate.
- Use an issue to discuss protocol changes, new dependencies, security boundaries, or substantial
  user-facing behavior before investing in an implementation.
- Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).
- Keep one pull request focused on one coherent outcome.

## Development setup

Requirements:

- Node.js 22 or newer;
- pnpm 11; and
- a native build toolchain supported by `node-gyp` for daemon terminal development.

Install and verify the workspace:

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Run the daemon and browser client with `pnpm dev`. Run the Electron client separately with
`pnpm dev:desktop`.

## Development workflow

Use test-driven development for behavior changes:

1. add or update a test that demonstrates the missing behavior;
2. confirm the test fails for the expected reason;
3. implement the smallest complete change;
4. run the focused test; and
5. run `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm lint` before requesting review.

Tests run sequentially at the workspace root because packages consume the generated protocol
artifacts. Do not make the root test command parallel without first removing that build dependency.

[AGENTS.md](AGENTS.md) is the agent-facing summary of these commands, the project boundaries, and
the conventions below.

### Coverage

Every package with tests runs the `v8` coverage provider on each `vitest run`, and each one carries
its own global thresholds. A run that drops below them fails, so coverage is part of `pnpm test`
rather than a separate command. Report output is a text summary; the HTML and JSON reports are not
generated.

The thresholds are a floor, not a target. They were set from the first measured run of each
package, rounded down to the nearest whole percent, so the gate is green on the code as it stands
and catches a regression rather than describing an ambition. Raise a package's floor in the same
change that raises its real coverage. Never lower one to make a run pass.

Measured baseline, from the first coverage run of each package on Node 22:

| Package | Statements | Branches | Functions | Lines |
| --- | --- | --- | --- | --- |
| `@getdomovoi/protocol` | 97.14% | 91.87% | 98.57% | 97.50% |
| `@getdomovoi/daemon` | 84.94% | 78.13% | 86.68% | 87.71% |
| `@getdomovoi/ui` | 52.62% | 51.04% | 50.95% | 55.95% |
| `@getdomovoi/desktop` | 50.37% | 57.10% | 45.31% | 53.60% |
| `@getdomovoi/web` | 48.48% | 69.23% | 50.00% | 50.00% |

Thresholds in force, at or just under those numbers:

| Package | Statements | Branches | Functions | Lines |
| --- | --- | --- | --- | --- |
| `@getdomovoi/protocol` | 97 | 91 | 98 | 97 |
| `@getdomovoi/daemon` | 84 | 77 | 86 | 87 |
| `@getdomovoi/ui` | 52 | 51 | 50 | 55 |
| `@getdomovoi/desktop` | 50 | 57 | 45 | 53 |
| `@getdomovoi/web` | 48 | 69 | 49 | 49 |

The daemon's branch floor is a point below its measured 78.13% because a few of its suites cover
timing-dependent branches, and `@getdomovoi/web` sits a point below on the two figures that
measured as exact integers.

## Project boundaries

- The daemon owns canonical session, terminal, approval, and artifact state.
- Code, credentials, tool execution, and repository state stay on the execution machine.
- Remote daemon access requires authentication and daemon-terminated TLS; a non-loopback listener
  without TLS material refuses to start.
- Generated previews remain inside sandboxed artifact containers.
- Ask, Plan, and Build are permission modes; Auto is a separate control.
- Protocol additions require runtime validation and tests in `packages/protocol`.
- Browser and desktop clients share `packages/ui`; platform-specific behavior belongs behind a
  narrow adapter.

## Product and interface changes

The signed Claude Design handoffs under `design/` are the product and brand sources of truth.
Interface changes must preserve their interaction model and visual language unless an issue has
explicitly approved a design change.

Use shadcn/ui primitives for standard controls. Terminal rendering, preview containers, diff
viewing, and annotation overlays may use purpose-built components, but must follow the shared token
system and accessibility behavior.

Include screenshots or a short recording for visible changes at relevant desktop and mobile
widths. Describe keyboard, touch, loading, empty, and failure states when they are affected.

## Release metadata

Every workspace package shares one version and is released as one compatibility unit. Record the
release intent of a change with `pnpm changeset` and commit the generated file alongside the
change. `pnpm release:status` lists changed packages that still lack metadata, and
`pnpm release:invariants` fails when package versions drift apart, a workflow references an
action by a mutable tag, or `ROADMAP.html` is stale relative to `ROADMAP.md`.

`ROADMAP.md` is the reviewed roadmap source. `ROADMAP.html` is generated from it by
`scripts/roadmap-html.mjs`; run `pnpm roadmap:html` after editing the Markdown and commit both
files together.

Documentation-only and repository-tooling changes do not need a changeset. See
[docs/distribution.md](docs/distribution.md) for the release model.

## Commits and pull requests

Treat commits as small savepoints. Use concise Conventional Commit subjects, such as:

```text
feat(terminal): add ownership lease
fix(preview): reject expired access
test(web): cover install manifest
docs: add security policy
```

Keep the subject at 50 characters or fewer when practical. Add a body only when the reason is not
clear from the change.

A pull request should explain the problem, the chosen behavior, security or protocol impact, and
the verification performed. Draft pull requests are welcome; mark the request ready only when its
checks pass and no required work remains.

By contributing, you agree that your contribution is licensed under the repository's
[Apache License 2.0](LICENSE).
