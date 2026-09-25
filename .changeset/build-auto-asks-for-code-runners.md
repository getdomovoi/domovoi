---
"@getdomovoi/daemon": patch
---

Build auto no longer runs a package script without a card when the script's runner loads worktree
code. `pnpm test`, `pnpm build` and `pnpm lint` whose bodies run vitest, jest, mocha, ava, eslint,
prettier, stylelint, oxlint, knip, madge, vite, tsup, rollup, esbuild, swc, webpack, next, astro,
changeset, attw or publint now ask on every run, because those runners execute test files,
JavaScript config, plugins or lifecycle scripts the agent can write. Scripts that run only `tsc`,
`tsd` or `biome` are still allowed. A hard gate anywhere in a script graph is now found even when an
earlier step already needs review.
