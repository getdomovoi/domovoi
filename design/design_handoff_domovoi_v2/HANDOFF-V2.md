# Domovoi v2 design handoff

Written 2026-09-07. Supersedes nothing: the v1 files stay at the project root as the
record of the previous direction. v2 is a separate set of files, listed below.

v2 exists because the v1 desktop showed a rail, a sessions sidebar, a mode switcher, a
thread, an inspector and a composer toolbar at once. v2 keeps every capability and
changes what is on screen by default.

## The files

| File | Surface | Steps |
|---|---|---|
| `Domovoi Desktop V2.dc.html` | Desktop sessions, the main flow | 15 |
| `Domovoi v2 Onboarding.dc.html` | First run, install, auth, machines, repository | 6 |
| `Domovoi v2 Cloud.dc.html` | Domovoi Cloud status, failure modes, billing | 8 |
| `Domovoi v2 Skills.dc.html` | Skills, install sources, trust | 5 |
| `Domovoi Web v2.dc.html` | Browser client, always over Cloud | 6 |
| `Domovoi Tablet v2.dc.html` | Tablet, two pane, touch-first | 4 |
| `Domovoi Phone v2.dc.html` | Phone, iOS and Android, keyboard and gates | 19 frames |
| `Domovoi v2 Team.dc.html` | Seats, org machines, cross-person history, policy, billing | 5 |
| `Domovoi v2 States.dc.html` | Empty, loading, failed, no-results, nothing-run-yet | 5 |
| `Domovoi Desktop Simplified.dc.html` | The two directions this came from, 1a and 1b | — |

Every file carries a step bar above the window. Each step's caption states the design
rule that step exists to demonstrate, so the reason survives the handoff.

Tweaks: `theme` everywhere; `platform` (mac, windows, linux) on the desktop files, which
drives shortcut labels and window chrome; `tailnet` on onboarding, which switches the
detected and not-detected stories.

## What changed from v1

Removed from the default view: the rail, the permanent sessions sidebar, the mode
segmented control, the permanent right inspector, and the composer toolbar.

Where they went:

- Sessions are a drawer on a panel button, grouped Running / Needs you / Quiet.
- Everything else is reachable from the command palette.
- Machine surfaces (plan preview, preview, changes, terminal, checkpoints, rules) are
  tabs in one sheet that can be pinned into a resizable right panel.
- Permission mode and model are chips inside the composer.

Kept always visible, deliberately: the machine chip, because it says where code is
running, and any waiting gate, because it blocks work.

## Decisions this design makes

**The plan is a pinned strip, not a message.** It sits above the composer with the
current step, its state, and a chevron that expands the steps upward. The thread keeps a
one-line record of when the plan was written. Rationale: a plan keeps changing state
while the conversation scrolls past it, so the version you scrolled away from is stale.

**Slash commands act on this turn; the palette navigates.** `/run` still hits the gate,
and the approval card says the request came from you rather than from the plan. There is
no `/clear`, because in a thread tied to a worktree and checkpoints it means nothing
honest.

**Attachments have two kinds, and the UI says which.** A repo path is read in place on
the machine. A file from this device has to travel, and when the machine is remote the
chip says it leaves this computer and names the route.

**Not every gate is a question.** A policy refusal (step 3b) has no allow button. The
card names the rule, who set it, its scope, that there is no override even with approval,
and what to do instead.

**Unknown is not failed.** After a dropped connection, tool calls without a recorded
result are shown as unconfirmed and the agent stops rather than guessing.

**Capability enforcement is in the daemon.** The Free tier's refusals and the untrusted
skill refusal both come back from the daemon as typed reasons. No surface hides a control
to fake a limit, because a hidden button is a preference and a refusal is a boundary.

**A hosted record is not a credential.** Removing a route from the account stops Cloud
admitting new attachments and does nothing else. The Cloud "route refused" screen states
that no device was revoked and direct routes are unaffected.

**Tailscale is detected, never managed.** Onboarding gains a Private network transport
listing MagicDNS nodes, states that a tailnet route is not a login, and offers a copyable
ACL rather than editing yours. When a tailnet is up, the Cloud sign-in demotes itself.

## Pricing and Cloud copy, per the 2026-09-06 plan

The meter is machines registered to the account, in buckets, with capability gating
inside each bucket. Clients are never metered. Free is one machine with a relay route and
JSON-RPC capability only. Enthusiast is $10 a month or $100 a year for three machines,
terminal over the route, the browser client and session moves. Team is $12 per seat with
a two seat minimum. Enterprise is quote-only with a $250 floor. Trial is fourteen days of
Enthusiast, no card, once per account.

A lapse never severs a live connection. The only enforcement is that new admission tokens
stop minting, and direct transports are never gated by a billing state.

Copy rules followed here: "Domovoi Cloud" names the product, "relay" only ever describes
the mechanism, and "runs with no account at all" appears nowhere.

## Verified against the repo, 2026-09-08

Read at tree digest `510ae3a2f359` on `main`. Where v2 and the code disagree, the code
wins and the design has to change.

**Skills exist, and v2 got the model wrong.** `packages/protocol/src/skills.ts` is
detailed. Corrections needed:

- Install has one source, `path`. The bundle-or-URL, installer-command, copy-from-a-machine
  and scaffold sources in `Domovoi v2 Skills.dc.html` have no wire representation.
- Capabilities are `filesystem.read`, `filesystem.write`, `process.execute`,
  `network.connect`, `secrets.read`, `preview.render`. The design shows `read_file`,
  `bash`, `write_file`, `network`.
- Trust has three states, and the missing one matters: `blocked`, for an invalid
  signature or a revoked signer. The design only has untrusted and trusted.
- Trust can be earned by `manual-review` as well as by a verified signature, so "unsigned
  therefore untrusted forever" is wrong.
- Enablement is a per-project review pinned to a content digest and a manifest. Editing a
  skill invalidates it and the turn refusal reason is `review-changed`. The design has an
  enable switch with no review concept at all.
- Turn selection is capped at eight skills, with refusal reasons `not-enabled`,
  `unavailable`, `review-changed`, `policy`. `/skill` in the design implies no cap.
- Install refusals are `source-changed`, `blocked`, `name-conflict`,
  `symlink-escapes-source`, `source-too-large`. None are drawn.

**Permission modes are wrong in v2.** The protocol has `ask | plan | build` plus a
separate `auto` boolean that is only legal with `build`. The composer chip cycles
"Read only / Ask before writes / Auto in worktree", which matches nothing. v1's
PermissionMode component had this right.

**Checkpoints are real.** `checkpoint.create`, `checkpoint.restore`, a `checkpoints`
history category and a `checkpoint` thread item. The sheet tab is well founded; it should
use commit shas where the schema does.

**Cloud is further from the code than "not built".** `client-admission.ts:22` refuses a
relay transport by name. Every Cloud-dependent screen — the whole Cloud file, all of Web
v2, the remote attachment warnings, the Cloud route chips — is post-relay work.

**There is a phone app in the repo.** `apps/mobile`, React Native, with session detail,
turn skills, fleet load and connection notices already implemented. So the missing phone
surface is a design gap against shipped code, not future work.

## Built against the wired backend

Read the RPC table at `packages/protocol/src/rpc.ts` and designed the capabilities that had
no surface. What each one became:

- **Session lifecycle.** A session actions menu: pause, archive, fork from a checkpoint,
  restart the provider thread, with paused and archived notices that say what the daemon is
  still holding.
- **Emergency stop.** Titlebar control with the two real methods kept apart: pause everything
  stops at the next turn boundary, emergency stop kills processes now and says that
  half-written files stay half-written.
- **Usage.** A composer chip: turn, session, context against 200k, and the rolling provider
  window with its reset time.
- **Plan editing.** Edit on the plan strip, with a queued-edit notice stating it applies at the
  next turn boundary rather than the turn in flight.
- **Evidence.** The Changes tab is per-file evidence: which runs touched each file and whether
  they passed, plus a per-file revert that names its checkpoint.
- **History.** A tab filtered by turns, approvals, checkpoints and transfers, with fork from
  any turn.
- **Audit.** Its own screen: actor filters, verified device credentials rather than labels,
  count-based retention, export that writes locally, and the statement that Cloud cannot
  reconstruct a session from its own logs.
- **Annotations.** Comments live inside the design-studio preview, never as a peer tab. Anchor
  to an element or a quoted phrase, numbered pins, hover linking both ways, an
  anchor-unavailable state, and a send step that attaches them to the next turn as structured
  references carrying skill, document, variant, element and render digest. Variants are A, B, C
  with an explicit build-on-this choice. Present on desktop, web and tablet.
- **Terminal claim.** The Terminal tab names its claimant and offers take or release, because
  one claimant at a time is the real model.
- **Artifact authorization.** A signed-capability chip with expiry on the Preview tab, so a
  leaked preview URL stops working rather than exposing the directory.
- **Model discovery.** The model chip is a search over discovered models with harness filters,
  a capped list and a rediscover action, not a hardcoded set.
- **Device verbs.** Inline rename, rotate with a one-time credential reveal, and
  sign-this-device-out on the client's own row, each stating what revocation reaches.
- **Transfer recovery.** Two further handoff phases: a half-failed move where the source stays
  authoritative and the target's worktree expires on its own, and a pick-a-side conflict with
  no merge and nothing deleted.
- **Read-only clients.** An `access` tweak drives a watching-only state: the chip, the reason,
  and the gate, plan edit, attach, slash and terminal controls locked rather than merely
  described as locked.

Also corrected against the schema: permission modes are `ask | plan | build` with `auto` as a
separate control legal only with build, and the Skills file was rebuilt on `skills.ts`.

## The phone

`Domovoi Phone v2.dc.html` is 19 frames in four labelled rows, with an iOS and Android
toggle driving width, height, bezel, radius, status bar, tab bar inset and home indicator.

- **The decision path** (1-5): sessions with needs-you first, the gate full screen, the
  receipt naming the device credential, watching while the shell is claimed elsewhere, and
  a policy refusal with no approve button.
- **First run and unpaired** (6-10): launch naming route phases rather than spinning,
  sessions and machines unpaired, pairing by camera, and an idle healthy fleet.
- **Carrying on from the phone** (11-14): the thread, typing with a real platform keyboard,
  the attach sheet naming where bytes go, and a draft with two photos queued.
- **Reading what it made** (15-19): the step list, PLAN.md rendered (no raw view on a
  phone), a design-studio render with variants, commenting on an element, and the pinned
  plan as a sheet.

The gate's decisions ride in a floating blurred card, matching v1. The composer carries one
plan button, tinted while a step needs you.

## Organisation

`Domovoi v2 Team.dc.html` covers the tier with the highest price and, before this, no
screens. The load-bearing rules:

- A seat is a person and reaches nothing until the organisation grants it a machine.
- Machines are the metered unit. A grant is a route and a credential, not an account login.
- Owners set policy and hold billing. They cannot read a member's session, and the
  cross-person history records decisions while carrying no prompt, diff or thread.
- A policy is a refusal the daemon enforces everywhere; turning one off is not retroactive,
  and an unreachable machine keeps enforcing the last policy it received.

## Empty, loading and failure

`Domovoi v2 States.dc.html` covers the five states the other files assume away, with the
sidebar in its matching condition each time. The one that carries a rule: a partial thread
reads like a finished one, so a failed read renders nothing and states what is still true.
No-results and not-searched are shown as different answers.

## Design passes applied across the set

- In-product prose cut to one line each, mechanism kept.
- Amber reserved for a pending gate. Completed approvals, holdbacks, rotations and
  capacity readouts moved to info, success or primary.
- The gate given its own identity: 16px radius, amber frame, tinted shadow, one primary
  decision at full weight.
- Fact grids reshaped to their data: the policy refusal is a chain of custody, the
  half-failed transfer is a two-side comparison.
- Type: sans prose floored at 10.5px (`--text-micro`) with 168 values raised, card headers
  stepped to 13px/600, mono limited to machine output. The floor governs sans prose only.
  `--text-eyebrow` 9.5px and `--text-mono-xs` 10px are named roles below it and were left
  alone deliberately. Values with no token behind them, notably `9px` and `8px`, are the
  real violations; `packages/ui/src` still carries 46 of those and they are not swept here.
- 71 radii, paddings, control and dot sizes snapped onto a named set.
- Light theme judged: a `--warning-foreground` token fixes ink on amber fills, and the
  phone keyboard is tokenised so light mode gets a light keyboard.
- Lucide throughout. No hand-drawn SVG icons remain in any v2 file.

## Known gaps


- The shipped phone app is still v1; `Domovoi Phone v2.dc.html` is design-only.
- Push notifications and the offline read cache are not designed. The notification body
  is an unresolved payload boundary question.
- The blur behind the composer and plan strip is a third use of a technique the
  foundations permit in two places. Either add it to the foundations or drop it.
- Web and tablet reuse the desktop's gate copy verbatim. It reads correctly, but neither
  has had its own copy pass.
- Hosted revocation is deliberately absent, per the plan's advice not to ship a control
  that says "revoke" while only deleting a hosted record.
