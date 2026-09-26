# Dependency licensing

The daemon, protocol, clients, and local transports are Apache-2.0. Anything that ships inside a
published Domovoi package has to be compatible with that, and the compatibility has to be checked
rather than assumed.

## Policy

`license-policy.json` holds the policy. `allowed` lists the license identifiers permitted in what
Domovoi publishes:

- the production dependency graph of the four npm packages named in
  `scripts/release-packages.mjs`: `@getdomovoi/protocol`, `@getdomovoi/credential-store`,
  `@getdomovoi/daemon` and `@getdomovoi/cli`;
- the production graph of the desktop app and of every workspace package it ships, listed as
  `desktopPackages` in `scripts/dependency-licenses.mjs`. That includes `@getdomovoi/ui`, whose
  graph electron-vite inlines into the renderer bundle, and its two fonts; and
- Electron, the runtime every desktop build contains, listed as `bundledRuntimes`.

`pnpm licenses list` does not follow workspace links, so the audit names each workspace package.
`scripts/dependency-licenses.test.mjs` compares `desktopPackages` with the desktop's workspace
dependencies, so a new one fails the test until the list names it. Every allowed entry is
permissive and carries no source-disclosure obligation. A dependency that declares an SPDX expression rather than one identifier passes when
the expression resolves against that list: any branch of an `OR`, every term of an `AND`.

`exceptions` maps a package name to the reason it may stay despite a license outside that list. A
key may end in `*` to cover a family of packages whose exact name depends on the host, such as the
per-platform binaries of a native dependency. An exception is a recorded decision, not a silencer:
the audit fails when an exact-name exception is no longer in the graph, so the file cannot drift
into a list of stale excuses. Pattern exceptions are exempt from that rule, because the platform
binary present on a Linux runner is by definition absent on a macOS one.

Run the audit with:

```bash
pnpm license:audit
```

It reads the graph from `pnpm licenses list --prod`, so it reports the licenses actually installed
for the current lockfile rather than the ranges written in manifests. Electron's entry comes from
the installed `electron` manifest. CI runs it on Linux, macOS, and Windows.

The audit reads Electron's declared license only. Chromium and the other projects Electron builds
on carry their own licenses, which Electron publishes as `LICENSES.chromium.html`; the policy does
not evaluate them one by one, and every desktop build ships that file unchanged.

## Notices in the desktop app

The renderer's JavaScript bundles carry no license comments, and the app does not ship the
`node_modules` copies of renderer packages. The notices therefore travel as files in each build:

- `THIRD_PARTY_NOTICES.txt` in the app's resources directory names every package of the desktop
  graph above with its version and declared license, followed by the license and notice files that
  package publishes. `scripts/third-party-notices.mjs` writes it from the installed graph during
  `prepackage`, so it describes the packages of the host that packaged the build. It leaves out the
  `@anthropic-ai/claude-agent-sdk-*` platform packages, which the app does not contain, and
  Domovoi's own packages.
- `LICENSE.electron.txt` and `LICENSES.chromium.html` come from Electron's downloaded `dist`.
  Linux and Windows builds keep them beside the executable; macOS builds carry them in
  `Contents/Resources`. The notices script refuses to run without them, so packaging stops rather
  than shipping a build that lacks them.

`scripts/desktop-package-contents.test.mjs` checks that the packaging configuration copies these
files on every platform, and `apps/desktop/scripts/package-smoke.mjs` checks that a packaged
build contains them.

The release SBOMs' inventory is broader: it comes from the packed all-platform runtime lock, or
for the CLI and the credential store from `pnpm-lock.yaml`, including optional binaries absent
from this host and the workspace packages each one depends on. Local license
observations annotate exact versions only. Missing observations stay empty rather than removing
a component or borrowing a related package's license. See [distribution.md](distribution.md#release-artifacts)
for the scope and the offline schema validation boundary.

## Current exceptions

`@anthropic-ai/claude-agent-sdk` and its per-platform binaries, covered by
`@anthropic-ai/claude-agent-sdk-*`, publish no SPDX license: their manifests say
`SEE LICENSE IN README.md` and `SEE LICENSE IN LICENSE.md`, which `pnpm licenses list` reports as
`Unknown`. Their `LICENSE.md` reads, in full: "© Anthropic PBC. All rights reserved. Use is
subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance."
They are proprietary, and they are a runtime dependency of the Claude Code session adapter in the
Apache-2.0 daemon. This document records what Domovoi ships; it does not interpret those terms.

How the exception is recorded:

- `license-policy.json` names both keys with the reason. The audit passes them and fails on any
  other package without an allowed license. It also fails if the exact-name key leaves the graph,
  so the exception cannot outlive the dependency.
- The daemon manifest's `license` field is `Apache-2.0`, which describes the daemon's own code. A
  manifest has no field for a dependency's terms, so the daemon README's License section states
  the exception. npm packs that README into every daemon tarball and shows it on the package page.
- The desktop app's `THIRD_PARTY_NOTICES.txt` carries the SDK's `LICENSE.md` text, as it does
  for every package the app bundles.

This is a known constraint, not a resolved one. What each artifact carries:

- The daemon's npm package declares the SDK as a dependency. npm installs it, and the platform
  package for that host, from the registry under Anthropic's terms. Domovoi does not publish a
  copy of either.
- The desktop app bundles the SDK's JavaScript library, because the daemon inside it imports that
  library. It does not bundle any `@anthropic-ai/claude-agent-sdk-*` platform package, so it
  carries no copy of the Claude Code agent binary. `apps/desktop/electron-builder.yml` excludes
  them and `scripts/desktop-package-contents.test.mjs` checks the exclusion.
- The daemon never runs the SDK's own agent binary. It finds `claude` on the tool PATH, the same
  executable provider readiness reports, and passes that path to the SDK. With no `claude`
  installed, Claude Code sessions do not start. On Windows it takes only the native `claude.exe`,
  because the SDK starts the executable without a shell and the npm `claude` and `claude.cmd`
  shims need one. A `claude` older than the SDK's `claudeCodeVersion` (2.1.263 for SDK 0.3.263)
  is refused with the version to install, and readiness says the same. Domovoi does not install,
  patch or re-sign that binary.

Removing the exception requires one of:

- driving the Claude Code adapter through the installed CLI over the Agent Client Protocol, as the
  Cursor and Grok adapters already do, and dropping the SDK dependency;
- moving the SDK to an optional dependency loaded only when a user opts into that adapter, so the
  default install of the public daemon carries only permissive licenses; or
- a written confirmation from Anthropic that redistribution inside an Apache-2.0 package is
  permitted.

Until one of those lands, the daemon's npm package carries a dependency whose terms are not
Apache-2.0, and the desktop app carries the SDK's JavaScript library under those terms. Say so in
release notes rather than implying the whole install is Apache-2.0. `release:github` builds the
release notes from each package's changelog entry and adds nothing on its own, so the statement
reaches a release only when a changeset in that release carries it.

## Claude Agent SDK peer dependencies

`@anthropic-ai/claude-agent-sdk` declares `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, and
`zod` as peer dependencies. The daemon names the first two in its own `dependencies` rather than
leaving them to an installer's automatic peer resolution, so the requirement holds under yarn and
under pnpm with `auto-install-peers=false`. Both are MIT and were already present in the audited
production graph through the SDK, so the declaration adds no license and no new resolution: the
lockfile gains two `importers` entries and no package version.

## Renderer fonts

The desktop renderer bundles the `.woff2` files of `@fontsource-variable/instrument-sans` and
`@fontsource-variable/jetbrains-mono`, which are licensed under the SIL Open Font License 1.1.
OFL-1.1 is not in `allowed`, so each font has a named exception. Condition 2 of that license
permits bundling the font with software provided each copy contains the font's copyright notice
and the license; `THIRD_PARTY_NOTICES.txt` carries both. Condition 1 forbids selling the font by
itself. A new OFL-1.1 package fails the audit until it is reviewed the same way.

## Development dependencies

Development dependencies are out of the audit's scope, with one exception. Build tooling does not
reach a user's machine, and holding it to the redistribution rules of published artifacts would
reject tools that never ship. Electron is the exception: it is a development dependency of
`apps/desktop` because electron-builder bundles it rather than installing it, and every desktop
build contains it, so the audit and the notices include it.
