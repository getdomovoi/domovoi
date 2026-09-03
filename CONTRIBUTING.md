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
`pnpm release:invariants` fails when package versions drift apart or a workflow references an
action by a mutable tag.

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
