# Design conformance

`v2-manifest.json` maps all nine current vendored v2 designs to one inventory and its
production implementation scope. It records the binding precedence: current design HTML,
approved exception ledger, then production behavior. Old design documents and tests do not
override v2. The gate checks the manifest, each present inventory, and the desktop and phone
structural contracts through `pnpm design:conformance` and `pnpm release:invariants`.

Components and studies vendored beside the v2 designs have inventories of their own, outside the
manifest: `TailnetReach`, `PairingCard` and `RemoteBrowser` (imported by Desktop V2 and v2
Onboarding, whose template holds only the import), `Domovoi Pairing Layouts`, `Domovoi Projects`,
`Domovoi CLI Transcripts` and `Domovoi Turn Skills Options`. The gate checks every `*-v2.json` in
this directory.

Every other invariant in this repository has a gate because it drifted once. Design conformance
drifted for weeks with none: the designs were converted into itemised change lists and the items
were built, so anything not itemised was never built, and no check said so. The inventory is the
itemisation, kept here rather than under `design/` because that tree is the signed handoff and is
never edited, and the check fails when the two disagree.

## What the gate holds

- The inventory records the sha256 of the design file it was derived from. A re-vendored design
  with a new digest fails until the inventory is re-read and the digest recorded with a new
  `derivedOn`.
- Every literal string the design's template draws (text nodes, `aria-label`, `placeholder`,
  `title`) must be claimed by exactly one element's `copy` or listed under `sample` (the
  fictional session: repository names, the task, machine names, times) or under `annotations`
  (frame names and numbers, section eyebrows, step captions: the design's intent for a human
  reader, which no rule holds). A string the design adds that nothing claims fails; a string an
  element claims that the design no longer draws fails.
- The same holds for copy the design builds in its data script (the `data-dc-script` block) and
  draws through a binding: menus, notices, palette commands, launcher chips. A script string
  counts when it reads as prose: a string literal outside comments that starts with a letter,
  holds a space, and is not markup, an interpolation or a style value.
- Script strings nobody has classified yet sit under `scriptBacklog` (`since`, `reason`,
  `strings`), each named. The check prints how many remain beside the built count. A script
  string that is neither claimed nor listed fails, so a re-vendored design cannot add one
  unread; a listed string the design no longer holds, or one an element now claims, fails until
  it leaves the list.
- Each element is one of:
  - **built**: every `evidence` entry is met in the implementation sources.
  - **partial** (dated reason): `presence` proves the element exists today, `evidence` names what
    the design draws that is not there yet, and not all of it may be met.
  - **missing** (dated reason): not built. If its evidence turns up, the check fails until the
    entry is removed, so the list only shrinks honestly.
  - **blocked** (dated reason, `needs`: `protocol` | `platform` | `design`): cannot be built as
    drawn. A finding for the maintainer, not an allowlist entry.
- Evidence is a string the sources must contain, `re:` plus a pattern, or `{ "absent", "in" }`: a
  string one named file must not contain. The last is how "these controls leave the composer"
  is a rule.
- The manifest rejects missing mapped inventories, unapproved visible exceptions, a permanent
  desktop rail or inspector token, and the legacy phone Review/Fleet shell. The phone contract
  also requires the Sessions, Machines, Settings order.
- The approved exception ledger is limited to the send hint, denial explanation, provider
  recovery, development-only credential diagnostic, mobile emergency stop, and startup/security
  recovery. A new visible exception fails until it receives an explicit decision.

## What it does not hold

Where an element sits, how a state looks, and whether the behaviour behind the copy is right.
Those are a human reading against the design; `where` and `states` on each element are notes for
that reader, and `humanRead` lists, dated, the elements whose remaining gap is arrangement rather
than copy. The check prints that count so nobody mistakes a green gate for a conformance review.

Script copy under `scriptBacklog` has been collected but not read against the implementation, so
an element whose drawn copy is only in the backlog can still count as built. Built counts are not
a conformance figure until the backlog is empty. The script reading also misses single-word
labels and strings the design assembles at run time. It does not parse regular expression
literals: one that holds a quote would read as a string, and one that holds `//` hides the rest
of its line. No current design has the first; the one case of the second hides only a
backslash.

## Re-deriving after a design change

1. Read the whole vendored file (it is a repository file; the 256 KiB cap is on fetching the live
   project, not on reading this copy).
2. Run `pnpm design:conformance`. It names the new digest, every unclaimed string and every stale
   claim.
3. Classify each new string, template or script: an element's copy, sample or annotations. Add
   elements for anything the design now draws that no element covers, with a dated `missing` or
   `partial` entry. Do not add new strings to `scriptBacklog`; it only shrinks.
4. Record the digest and today's `derivedOn`.
