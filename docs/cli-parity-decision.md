# CLI parity decision

Status: decided by fetzy on 2026-09-10. Partly implemented, differently from the record below;
see "`domovoi daemon` as built" and "State on 2026-09-22".
Applies to S1.6 in [SHIP-PLAN.md](../SHIP-PLAN.md).
Source checkout: `e2d598f` on `feat/launcher-entity-rows`.

## `domovoi daemon` as built (2026-10-07)

Ruling Q3 B (fetzy, 2026-10-06) settled where the service lifecycle commands live, so that one
code path installs the service:

- `@getdomovoi/daemon` exports `@getdomovoi/daemon/daemon-command` (#757). Its
  `runDaemonCommand` reuses `runServiceCommand` (`apps/daemon/src/service/install.ts`) and
  registers `daemonWorkerEntry()`: the package's own `dist/index.js`, resolved from the module's
  location rather than from `process.argv[1]`.
- `@getdomovoi/cli` depends on `@getdomovoi/daemon`. `domovoi daemon install|status|remove`
  (`apps/cli/src/index.ts`) calls `runDaemonCommand([verb])`. An installed-package test
  (`scripts/bootstrap-real-daemon.test.mjs`) packs the protocol, credential store, daemon and CLI
  packages, installs them with npm, and shows that `domovoi daemon install` registers the
  daemon's `dist/index.js`, not the CLI's. `apps/cli/src/cli.e2e.test.ts` covers the same
  commands against the built workspace.
- The exit codes are those of `domovoid service`, not the CLI's table: `status` exits 0 when the
  service is installed, even if it is stopped, and 1 when it is not or its supervision failed;
  `install` and `remove` exit 0 on success and 1 on failure. A verb the CLI does not have, or a
  surplus word, is the CLI's usage error, exit 2, before anything runs.
- `domovoid service install|status|remove` stays as the daemon's own entry. Unlike the migration
  target below, it is not retired.
- Follow-up lines name the command that was run (ruling Q28 A, 2026-10-07): `domovoi daemon ...`
  through the CLI, `domovoid service ...` through `domovoid`. Profile recovery has no `domovoi`
  form and `domovoid` may not be on `PATH`, so through the CLI it reads `domovoid profile recover
  --confirm-no-supervisor (domovoid is Node running <daemon entry>)` (ruling Q33 A, 2026-10-07).
  The supervised worker's exhaustion lines are printed by a service process, not a command, and
  name both status commands.
- The desktop runtime ships the CLI without a second copy of the daemon. When
  `@getdomovoi/daemon` cannot be found, the CLI loads one fixed path,
  `<runtime>/daemon/dist/daemon-command.js` beside its own `dist`, and searches nowhere else. So
  `domovoi daemon install` through the app's linked `domovoi` runs the runtime's daemon, which
  copies the runtime out of the app before registering it (Q408 A). With neither present, the
  command refuses and names the missing package (ruling Q31 A, 2026-10-07).
- On Node 22 a daemon command prints Node's SQLite `ExperimentalWarning` on stderr, as `domovoid`
  does (ruling Q32 A, 2026-10-07).

Still not decided: which other `domovoid` commands move to `domovoi`. `domovoi status` stays the
summary below; `domovoi daemon status` is the narrower service check.

## State on 2026-09-22

The user-facing `domovoi` binary shipped as its own package, `@getdomovoi/cli` in `apps/cli`
(3375cd96, 2026-09-11), not as an entry in `@getdomovoi/daemon` as "Migration target" below
records. It carries `pair`, `status`, `doctor`, `logs` and `skill install <path>`
(`apps/cli/src/index.ts`). `skill push` does not exist.

On 2026-10-01 fetzy took `skill push` out of M1 (ruling Q284 A). It needs a destination,
transfer and overwrite rules, and a trust step on the receiving machine, which is a new
cross-machine RPC. Remote skill distribution is a later fleet feature. S1.6 stays open for the
rest of its scope: install and service status, and the pairing gap below.

No human command has moved off `domovoid`. Its help (`apps/daemon/src/index.ts`) still lists
`pair`, `fleet-keychain`, `open`, `wsl list`, `secret`, `service install|status|remove`,
`skill keygen|sign|trust` and `profile recover`. On 2026-09-22 the two surfaces did not meet at
pairing: `domovoid pair --client cli --label <device label>` printed a one-time pairing code,
while `domovoi pair` accepted only a client credential and refused a code. On 2026-10-03, under
ruling Q337 A, `domovoi pair` redeems that code with `device.redeemCode`, the phone's path, so
there is one pairing flow and the daemon did not change.

Not decided on 2026-09-22: whether the separate package replaces the one-package target below,
and which `domovoid` commands still move to `domovoi`. Ruling Q3 B answered the first for the
service commands; see "`domovoi daemon` as built". The rest of this document is the 2026-09-10
decision, not a description of the code.

## Decision and evidence

`domovoi` is the user-facing CLI. `domovoid` is the daemon execution process.
Move every human command off `domovoid`; retaining two working command surfaces is not
the migration. The lifecycle noun is `daemon`, so installation is
`domovoi daemon install`.

This naming was already specified. Treating it as an unanswered preference overlooked
the product sources:

- The [design system readme, line 10](../design/design_system_domovoi/readme.md#L10)
  names the domain `domovoi.sh`, GitHub organization `getdomovoi`, and CLI `domovoi`.
- [V2 Onboarding, lines 506 and 606](<../design/design_handoff_domovoi_v2/designs/Domovoi v2 Onboarding.dc.html#L506>)
  uses `domovoi daemon install` in its installation command and example log.
- [V2 Onboarding, line 634](<../design/design_handoff_domovoi_v2/designs/Domovoi v2 Onboarding.dc.html#L634>)
  uses `domovoi auth claude-code`.
- [V2 Cloud, line 492](<../design/design_handoff_domovoi_v2/designs/Domovoi v2 Cloud.dc.html#L492>)
  uses `domovoi machine check wsl-ubuntu-24`.

No `domovoid` occurrence was found in `design/design_handoff_domovoi_v2` at the source
checkout. The positive naming and command examples establish the decision; absence alone
would not. The signed handoffs are evidence and must not be edited to match the old CLI.

## Current implementation

[The daemon package](../apps/daemon/package.json#L20) declares only
`domovoid`, pointing to `dist/index.js`. That entry handles both daemon startup and human
commands in [index.ts, lines 118-279](../apps/daemon/src/index.ts#L118).

`service install`, `service status`, and `service remove` already execute through
[runServiceCommand, lines 507-568](../apps/daemon/src/service/install.ts#L507).
These implementations can be reused behind the new command surface. They do not establish
the product spelling or prove the complete onboarding behavior exists.

`pair`, `open`, `wsl list`, provider secret commands, fleet-keychain recovery, and profile
recovery also exist. [runSkillCommand, lines 48-71](../apps/daemon/src/skill-command.ts#L48)
accepts `keygen`, `sign`, `trust`, and `add`. The top-level help currently omits `skill add`.
At the source checkout, `doctor`, `logs`, and `skill push` had no handlers or defined behavior.
`doctor` and `logs` now exist in `apps/cli`; `skill push` still does not.

## Migration target

Use one thin `domovoi` entry in the existing `@getdomovoi/daemon` package, with command
handlers extracted from the worker entry as needed. Keep one implementation of each
operation and one package version. Importing a command handler must not start a daemon.

The following mapping carries existing behavior to the human CLI. Lifecycle `status` and
`remove` follow the design's `daemon` noun; they are migration mappings, not additional
commands quoted from the handoff.

| Existing invocation | Migration target | Behavior carried over |
| --- | --- | --- |
| `domovoid service install` | `domovoi daemon install` | Register and start the per-user daemon service using the existing platform implementation. |
| `domovoid service status` | `domovoi daemon status` | Report service installation and running state. |
| `domovoid service remove` | `domovoi daemon remove` | Remove service registration with the existing ownership and recovery checks. |
| `domovoid pair [options]` | `domovoi pair [options]` | Issue a pairing code or the explicitly requested client credential. |
| `domovoid open [path]` | `domovoi open [path]` | Resolve and open the workspace, including the existing WSL path flow. |
| `domovoid wsl list` | `domovoi wsl list` | Discover WSL distributions and their daemon endpoints. |
| `domovoid secret <status\|set\|delete> ...` | `domovoi secret <status\|set\|delete> ...` | Keep current provider API-key operations. |
| `domovoid skill <keygen\|sign\|trust\|add> ...` | `domovoi skill <keygen\|sign\|trust\|add> ...` | Keep signing, trust, and reviewed local installation behavior. |
| `domovoid fleet-keychain <list\|forget> ...` | `domovoi fleet-keychain <list\|forget> ...` | Keep exceptional local credential recovery and its explicit confirmation. |
| `domovoid profile recover --confirm-no-supervisor` | `domovoi profile recover --confirm-no-supervisor` | Keep the operator's no-supervisor assertion and profile recovery checks. |
| `domovoid --help` / `--version` | `domovoi --help` / `--version` | Human help and installed package version, including existing short flags. |

The migration should preserve argument validation, credentials, permission checks,
deadlines, output meanings, and exit semantics for existing operations. For example,
current service status exits successfully when installed, even when stopped. Changing that
meaning belongs in a separately specified behavior change.

`domovoi` with no command should show help and exit without starting a worker. Retired
human invocations on `domovoid` should fail with a nonzero exit and the replacement command
name. They must not execute, silently forward to `domovoi`, or echo sensitive arguments.
There is no continuing `domovoid service ...` compatibility alias. Update old usage text
and recovery instructions together with the dispatchers.

### What stays on domovoid

Retain the worker startup contract used by service managers and programmatic supervisors:

- No command: start the daemon using its existing environment and profile configuration.
- `--service-config <path>`: start with the installed non-secret service configuration.
- The existing listener, profile ownership, endpoint publication, and signal-driven
  shutdown behavior.

Keep existing worker entry paths valid for installed service registrations. In particular,
[index.ts, lines 169-185](../apps/daemon/src/index.ts#L169) currently derives the registered
entry from `process.argv[1]`. After the split, `domovoi daemon install` must explicitly
resolve the packaged worker entry. Registering the frontend's own entry would start the
human CLI when the supervisor expects a daemon.

Move help/version callers and probes to the human entry or package metadata as appropriate.
`domovoid` does not retain operational subcommands for people. The service configuration
format, credentials, and stored workspace state do not need renaming to change the CLI.

## Behavior still to specify

The name is settled. The migration does not supply contracts for unfinished commands:

- [V2 Onboarding, line 679](<../design/design_handoff_domovoi_v2/designs/Domovoi v2 Onboarding.dc.html#L679>)
  shows `domovoi status` with machine, route, daemon version, agent count, and session count.
  A bare alias to service status would omit those facts. Define the summary and unavailable
  states before implementing it; `domovoi daemon status` carries the narrower existing check.
- The installation log depicts fetching and verifying a runtime, while current service
  installation registers an already available entry. Specify how bootstrap and service
  registration compose before claiming complete installation parity.
- `domovoi auth claude-code` is a provider authentication flow. It is not established by
  renaming `secret set`, which stores an API key.
- `domovoi machine check` needs a defined target and diagnostic contract. Do not silently
  substitute the undefined `doctor` command for the design's command.
- `doctor` needs check scope and result/exit semantics. `logs` needs sources, selection,
  redaction, follow/termination behavior, and its relationship to S1.5 retention.
- `skill push` needs a destination, transfer and overwrite rules, and trust/approval
  behavior. Existing `skill add` performs reviewed local copying and does not establish
  remote distribution.

None of these gaps authorizes Phase 2 relay work. S0.2 crypto and S0.6 repository location
remain its gates.

## Implementation sequence and verification

1. Codex separates the human entry and worker entry, reusing existing daemon handlers.
   Add tests for the migration before changing behavior, including refusal of retired
   worker commands and preservation of explicit recovery confirmations.
2. Update the daemon package's executable declarations and build outputs. Coordinate
   distribution scripts, onboarding copy, and client-owned callers with Claude Code under
   the one-agent-per-file rule. Check all existing callers, including help/version probes.
3. Ship the command migration with matching packaging, user instructions, and a changeset.
   Validate the installed package, not only source execution. Prove that installed services
   invoke the worker, the frontend exits after commands, and existing worker startup still
   works through the production launch smoke.
4. Run focused tests, then `pnpm typecheck`, sequential `pnpm test`, `pnpm build`, and
   `pnpm lint` before review. Any additional RPC contract must land with protocol validation
   and tests before clients consume it. fetzy owns the merges.

This change records the decision and migration path only. No executable, handler, package
metadata, or design source is changed with this record.
