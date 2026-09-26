# Leaving tsup

Status: plan, no migration yet. Written 2026-09-26 for audit finding E20.

`tsup` builds the `dist/` of all four npm packages, and the daemon's `dist/` is also what the
desktop app ships. Its README now says it "is not actively maintained anymore" and names a
successor. Its last release is 8.5.1, published 2025-11-12, and it declares `esbuild ^0.27.0`.
Two recorded exit conditions wait on tsup releasing again, which is not expected:

- the workspace `esbuild` override to `0.28.2` in `pnpm-workspace.yaml`, to be removed "once both
  declare ranges that include 0.28" (see [distribution](distribution.md#workspace-overrides));
- the TypeScript 7 hold in `.github/dependabot.yml`, lifted when "tsup bundles declarations without
  a TypeScript 6 peer".

The published artifacts therefore come from a bundler nobody patches, running on an esbuild minor
it was never released against.

## What tsup does here today

Measured on `main` at the date above. Every package builds ESM only.

| Package | Config | Entries | Declarations | Other options |
| --- | --- | --- | --- | --- |
| `@getdomovoi/credential-store` | `packages/credential-store/tsup.config.ts` | `index` | bundled `index.d.ts` | `platform: node`, `target: node22` |
| `@getdomovoi/protocol` | `packages/protocol/tsup.config.ts` | `index`, `relay/index`, `relay-admission/index` | bundled, with a shared hashed chunk (`relay-pin-recovery-<hash>.d.ts`) | none beyond defaults |
| `@getdomovoi/cli` | `apps/cli/tsup.config.ts` | `index` (the `domovoi` bin) | none | `removeNodeProtocol: false`, `target: node22` |
| `@getdomovoi/daemon` | `apps/daemon/tsup.config.ts` | `index` (the `domovoid` bin), `public`, `server`, `workspace-redaction`, `machine-keyring-worker`, `bootstrap-install` | bundled per entry | `noExternal: ["@getdomovoi/credential-store"]`, `removeNodeProtocol: false`, code splitting |

Contracts a replacement has to keep, and where they are checked:

- **Entry file names.** The daemon starts `dist/machine-keyring-worker.js` as a worker by path
  (`apps/daemon/src/machine-credential-worker.ts`), and the desktop package smoke loads it from the
  archive. `apps/daemon/test-dist.mjs` imports `dist/public.js`, `dist/server.js` and
  `dist/bootstrap-install.js` and pins the public export list.
- **Packed file sets.** The daemon's `files` globs are `dist/*.js` and `dist/*.d.ts`, so chunks and
  declarations must stay at the top of `dist/`. `scripts/test-package-artifacts.mjs` requires each
  package's entry points and declared files in the packed tarball and refuses source maps and
  source directories.
- **Declaration surface.** `apps/daemon/test-dist.mjs` asserts what `public.d.ts` and `server.d.ts`
  do not name. The daemon and `packages/ui` resolve `@getdomovoi/protocol` from its built `dist/`
  at test time, so protocol declarations are consumed by the typecheck of other packages.
- **The bundled credential store.** The daemon inlines `@getdomovoi/credential-store` rather than
  depending on it, so the daemon's runtime lock and npm dependencies do not name it.
- **`node:` specifiers.** The CLI and daemon keep `node:` imports, which tsup would otherwise strip.
- **Lazy chunks.** The daemon loads some providers by dynamic import (for example the
  `kilo-runtime-<hash>.js` chunk); the replacement must keep those out of the startup path.
- **Prepack builds.** The protocol, credential store and CLI build in `prepack`; the daemon's
  `prepack` embeds the packed protocol. Because the protocol build cleans the one `dist/` the
  workspace shares, `scripts/package-artifact-command.test.mjs` keeps packing tests from running
  beside each other. A replacement that cleans differently changes that constraint.

## Options

**A. The successor the tsup README names, `tsdown`.** It reads a config file of the same kind,
bundles declarations, and publishes a migration guide from tsup. Its defaults are not tsup's, so
each step pins the options that keep the contracts above, such as output file extensions, and
compares the packed file list. As of 2026-09-26 the registry lists `tsdown` 0.23.0: it depends on `rolldown`
`~1.2.7`, lists `typescript` `^5.0.0 || ^6.0.0 || ^7.0.0` as a peer, and requires Node
`^22.18.0 || ^24.11.0 || >=26.0.0` to run. The workspace already installs `rolldown` 1.2.6
through Vite 8, so this adds one tool and moves an existing dependency by a patch. Limits: it is
pre-1.0, so a minor may break the build, and its Node floor is above the packages' own
`>=22.13.0` engines. That floor applies to the build machine only, not to installs.

**B. esbuild directly, plus `tsc --emitDeclarationOnly`.** No new dependency: esbuild is already
in the graph and pinned. Limits: `tsc` emits one declaration file per source file rather than a
bundle, so the daemon's `dist/*.d.ts` glob, the protocol's subpath exports and the daemon's
inlined credential-store types all need rework, and the published declaration layout changes.
Each package needs a build script in place of a config file.

**Recommendation: A**, because it can produce the bundled declarations and top-level file layout
the contracts above check without a per-package build script, and it clears tsup's part of both
exit conditions. B stays the fallback if a `tsdown` release breaks one of those contracts. The choice needs the owner's approval before step 1.

## Order and proof

One package per change, smallest first, each in its own PR:

1. `@getdomovoi/credential-store`: one entry, bundled declarations, nothing else.
2. `@getdomovoi/protocol`: three entries and a shared declaration chunk; other packages consume
   its declarations.
3. `@getdomovoi/cli`: one entry, no declarations, `node:` specifiers kept.
4. `@getdomovoi/daemon`: six entries, the inlined credential store, lazy chunks, the worker entry
   and the runtime lock.

Each change is proved by:

- `pnpm test:packages`, which runs the packed-artifact contracts and the real release SBOM test;
- `pnpm release:artifacts` before and after, with the tarball file lists, the daemon's
  `runtime/lock.json` and the SBOM components compared; only build tooling may differ;
- `pnpm --filter @getdomovoi/daemon test:dist` for the daemon step;
- `pnpm typecheck` across the workspace for the protocol step, since other packages read its
  declarations; and
- the desktop package smoke in CI for the daemon step, which loads the worker from the archive.

## Exit

After the daemon moves, remove `tsup` from the four `devDependencies`, then:

- rewrite the `esbuild` override comment in `pnpm-workspace.yaml` and
  [distribution](distribution.md#workspace-overrides) against the new tool, or remove the override
  when every remaining consumer admits `0.28`;
- rewrite the TypeScript 7 hold in `.github/dependabot.yml` so it names only the consumers that
  still refuse 7.x; and
- update `.changeset` text and tests that name `tsup` as an example only if they describe this
  repository's build rather than a tool name in general.
