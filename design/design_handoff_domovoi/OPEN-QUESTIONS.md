# Domovoi — open questions for developer handoff

Decisions deliberately deferred during design. Carry these into the handoff package
and the engineering spec; each one changes daemon behavior, not just UI.

## 1. Machine transfer to an unreachable target — queue or refuse?

**Context.** In the desktop workspace, the composer machine chip opens a device menu;
picking a different machine runs a transfer preflight (commit to `refs/domovoi/ckpt/<session>`,
then either an incremental git bundle streamed daemon→daemon, or a pushed Domovoi ref on origin).

**Undecided.** What happens when the chosen target is offline at the moment of transfer.

- **Queue it** — friendlier, matches "agent runner" expectations, works well for a laptop
  that wakes up later. Risk: a session can move *silently*, minutes or hours after the user
  asked, on a machine they may no longer be near. Needs an explicit pending-transfer state
  in the UI, a cancel affordance, an expiry, and a notification on completion.
- **Refuse outright** — predictable and auditable; the session never changes hands without
  a live confirmation on both ends. Cost: the user has to come back and redo it.

**If queued, still to specify:** where the pending transfer is visible (fleet card badge?
session row state? both), TTL before it's dropped, whether the source worktree stays
writable while a transfer is pending, and what happens if the source diverges before the
target wakes up (re-bundle from the newer checkpoint, or abort).

Currently the design shows offline machines as `UNREACHABLE` and unselectable — i.e. the
refuse path — but only because it needed *a* behavior, not because it was chosen.

## 2. Model handoff — what the UI is allowed to promise

**Context.** Cross-provider switches are shown as a checkpointed handoff carrying the
Domovoi thread, plan, worktree, diff, tool and test results, open annotations, active
skills and permission mode. The receipt in the thread says exactly that.

**Undecided.** How loudly the *un*-carried state is surfaced. Hidden reasoning, provider
caches, proprietary compaction state and private session metadata do not transfer, and the
current design mentions this only in the handoff receipt's secondary line.

**To specify:** whether the pre-switch confirmation must enumerate the losses, whether a
handoff is blocked mid-stream or only deferred to the next safe turn boundary (design assumes
deferred), and whether "Switch here" vs "Fork with model" needs a different warning.

## 3. Skill install trust model

**Context.** Skills install from the built-in directory, user and project directories, Codex
and Claude skill paths, `.agents/skills`, or a terminal command (`npx`, `pnpm dlx`, `curl`).
The desktop skills panel exposes the terminal path because that is how most skills ship today.

**Undecided.** The gap between convenience now and the signed, content-addressed bundle plan
with capability review. A terminal install runs arbitrary code on a real machine with the
user's credentials.

**To specify:** whether terminal installs are gated behind a permission prompt like any other
privileged command (they arguably should be), what the capability manifest looks like, whether
unsigned skills can run in Build auto at all, and how a skill installed on one machine is
declared to the fleet without silently distributing executables.

## 4. Guest browser session scope

**Context.** The hosted web client supports short-lived, revocable guest sessions for a
borrowed computer. The design already prevents guests from creating standing permission rules.

**Undecided.** Whether a guest session may approve a hard gate at all — a migration, a deploy,
a secret read — or only view, deny and defer to a paired device.

**To specify:** the guest capability set, whether hard-gate approval requires a second factor
per decision, TTL defaults, and how the audit log distinguishes a guest approval from a
paired-device approval (it currently records originating client, which may be enough).

## 5. Public site — unfinished, needs design iteration

**Status.** `Domovoi Site.dc.html` is a **work in progress**, not a signed-off design. It
covers the required content (what Domovoi is, local-first architecture, subscriptions and BYOK,
cross-device operation, preview and annotation workflow, security boundaries, open-core split,
install, platforms, docs and GitHub) and it obeys the token contract, but the visual direction
and the copy have not been through real iteration.

**Known gaps.**

- One folklore-led direction was explored and scrapped. The current page is the plain,
  product-led voice — a default, not a decision.
- Marketing copy has had a single pass. Headlines, section order and the hero framing all need
  rewriting against a real positioning brief.
- Four product-shot placeholders are unfilled. The page's whole credibility depends on them, and
  layout may need to change once the real captures exist.
- No responsive work below the 1080px content column. Tablet and phone breakpoints are undesigned.
- No dark/light toggle. The site is dark-only, unlike the app surfaces.

**Copy constraint — do not reintroduce.** "Runs with no account at all" and similar
account-free framing has been removed from the site. That property is an artifact of backend
iteration 1, where the account service does not exist yet; it is not a product promise and must
not be marketed. Open-core messaging should stay on what is verifiable — the license, what code
is public, and that provider credentials and keys stay local. Whether the local product keeps
working indefinitely without a Domovoi account is a **product decision that has not been made**,
so no surface should imply it either way.

**Next step.** Run this through **design-studio** to generate and compare variants before any of
it is built: hero treatment, section rhythm, and whether the site leans architectural (diagrams,
transport order, security boundaries) or narrative (the household-spirit framing). Review the
variants side by side, annotate, and pick a direction. Treat the current file as the content
inventory to iterate against, not as the layout to implement.

Build the app surfaces first. The site should not be implemented from this file as-is.

## 6. (add further deferred decisions below as they come up)
