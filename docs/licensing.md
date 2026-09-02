# Dependency licensing

The daemon, protocol, clients, and local transports are Apache-2.0. Anything that ships inside a
published Domovoi package has to be compatible with that, and the compatibility has to be checked
rather than assumed.

## Policy

`license-policy.json` holds the policy. `allowed` lists the license identifiers permitted in the
production dependency graph of the publishable packages, `@getdomovoi/protocol` and
`@getdomovoi/daemon`. Every allowed entry is permissive and carries no source-disclosure
obligation. A dependency that declares an SPDX expression rather than one identifier passes when
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
for the current lockfile rather than the ranges written in manifests. CI runs it on Linux, macOS,
and Windows.

## Current exceptions

`@anthropic-ai/claude-agent-sdk` and its per-platform binaries, covered by
`@anthropic-ai/claude-agent-sdk-*`, publish no SPDX license. Their `LICENSE.md` reads
"© Anthropic PBC. All rights reserved.", with use governed by the Claude Code legal agreements.
They are proprietary, and they are a runtime dependency of the Claude Code session adapter in the
Apache-2.0 daemon.

This is a known constraint, not a resolved one. Domovoi does not redistribute the SDK: it is
installed from npm under Anthropic's terms, the same way the Claude Code CLI is. Removing the
exception requires one of:

- driving the Claude Code adapter through the installed CLI over the Agent Client Protocol, as the
  Codex and Cursor adapters already do, and dropping the SDK dependency;
- moving the SDK to an optional dependency loaded only when a user opts into that adapter, so the
  default install of the public daemon carries only permissive licenses; or
- a written confirmation from Anthropic that redistribution inside an Apache-2.0 package is
  permitted.

Until one of those lands, the daemon's npm package carries a dependency whose terms are not
Apache-2.0. Say so in release notes rather than implying the whole install is Apache-2.0.

## Claude Agent SDK peer dependencies

`@anthropic-ai/claude-agent-sdk` declares `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, and
`zod` as peer dependencies. The daemon names the first two in its own `dependencies` rather than
leaving them to an installer's automatic peer resolution, so the requirement holds under yarn and
under pnpm with `auto-install-peers=false`. Both are MIT and were already present in the audited
production graph through the SDK, so the declaration adds no license and no new resolution: the
lockfile gains two `importers` entries and no package version.

## Development dependencies

Development dependencies are out of the audit's scope. They are not shipped, and holding build
tooling to the redistribution rules of published artifacts would reject tools that never reach a
user's machine.
