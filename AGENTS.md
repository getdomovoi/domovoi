# Domovoi agent instructions

Rules for coding agents in this repository. [CONTRIBUTING.md](CONTRIBUTING.md) is the full guide.

## Commands

Root scripts in `package.json`:

- `pnpm lint`: eslint over `apps/**` and `packages/**` with `--max-warnings 0`.
- `pnpm typecheck`: `tsc --noEmit` in every package.
- `pnpm test`: builds `packages/protocol` (`pretest`), then runs each package's vitest suite, the
  daemon dist check, the `scripts/*.test.mjs` suite, and the desktop launch smoke, in sequence.
  Do not make it parallel; packages consume the generated protocol artifacts.
- `pnpm build`: every package build script.
- `pnpm performance:budget`, `pnpm release:invariants`, `pnpm license:audit`: scripts in `scripts/`.

Targeted forms:

- `pnpm --filter @getdomovoi/<protocol|daemon|ui|web|desktop> typecheck`
- `cd <package directory> && npx vitest run <file> --reporter=dot`
- `node --test scripts/<name>.test.mjs`

`packages/protocol` exports `dist/`. The daemon and `packages/ui` resolve `@getdomovoi/protocol`
from that build at test time; `apps/web` and `apps/desktop` alias it to `packages/protocol/src`.
After changing `packages/protocol/src`, run `pnpm --filter @getdomovoi/protocol build`.

## Workflow

Use test-driven development for behavior changes:

1. add or update a test that demonstrates the missing behavior;
2. confirm the test fails for the expected reason;
3. implement the smallest complete change;
4. run the focused test; and
5. run `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm lint` before requesting review.

## Design sources

The signed Claude Design handoffs under `design/` are the product and brand sources of truth. Do
not edit them. Interface changes must preserve their interaction model and visual language unless
an issue has explicitly approved a design change. Recreate the handoffs in the production stack;
do not port prototype markup or `support.js`.

## Copy rules

- Plain punctuation: no em dashes and no exclamation marks.
- Never use the phrase "control plane".
- Write `Domovoi` in prose and `domovoi` for the binary, packages, and domain. Do not abbreviate it.
- State mechanisms and limits. No unexplained security claims and no account-free promises.

## Architecture rules

- Daemon owns canonical session state.
- Code and secrets stay on the execution machine.
- Ask, Plan, and Build are permission modes. Auto is a separate control.
- Hard gates require explicit approval.
- Cross-provider handoffs carry documented Domovoi state, not hidden provider reasoning or caches.
- Clients collapse information for smaller screens; they do not omit approval facts.
- Preview documents execute only inside sandboxed artifact containers.
- Protocol additions require runtime validation and tests in `packages/protocol`.
- Browser and desktop clients share `packages/ui`; platform-specific behavior belongs behind a
  narrow adapter.

## Conventions

- Every package extends `tsconfig.base.json`: `strict`, `exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`,
  `isolatedModules`, and `verbatimModuleSyntax`.
- Use shadcn/ui primitives for standard controls; they live in `packages/ui/src/components/ui`.
- Commit subjects follow Conventional Commits, 50 characters or fewer when practical, for example
  `fix(preview): reject expired access`.
- Publishable behavior changes need a changeset from `pnpm changeset`. Documentation-only and
  repository-tooling changes do not.
