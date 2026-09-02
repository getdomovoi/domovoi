---
name: Domovoi
description: A local-first runner and control surface for AI coding agents across a user's machines.
colors:
  background: "oklch(0.165 0.005 285)"
  foreground: "oklch(0.96 0.003 285)"
  card: "oklch(0.205 0.006 285)"
  primary: "oklch(0.72 0.17 275)"
  primary-foreground: "oklch(0.17 0.03 275)"
  muted: "oklch(0.265 0.007 285)"
  muted-foreground: "oklch(0.66 0.01 285)"
  accent: "oklch(0.235 0.006 285)"
  border: "oklch(0.305 0.008 285)"
  success: "oklch(0.75 0.14 158)"
  warning: "oklch(0.79 0.13 62)"
  destructive: "oklch(0.63 0.19 25)"
  info: "oklch(0.72 0.1 240)"
  strong: "oklch(0.89 0.003 285)"
  faint: "oklch(0.53 0.01 285)"
  code: "oklch(0.145 0.004 285)"
typography:
  ui:
    fontFamily: "Instrument Sans, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "normal"
  title:
    fontFamily: "Instrument Sans, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  machine:
    fontFamily: "JetBrains Mono, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
rounded:
  control: "calc(0.65rem - 4px)"
  input: "calc(0.65rem - 3px)"
  track: "calc(0.65rem - 2px)"
  surface: "0.65rem"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "22px"
  section: "34px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.ui}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  approval-surface:
    backgroundColor: "oklch(0.235 0.045 62)"
    textColor: "oklch(0.94 0.05 68)"
    rounded: "{rounded.surface}"
    padding: "16px"
  machine-chip:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.strong}"
    typography: "{typography.machine}"
    rounded: "{rounded.input}"
    padding: "6px 8px"
---

# Design System: Domovoi

## Overview

The normative product-design source is the Claude Design system in the project "Relay multi-device
platform". The tracked bundles under
[`design/design_handoff_domovoi/`](design/design_handoff_domovoi/README.md) and
[`design/design_handoff_domovoi_brand/`](design/design_handoff_domovoi_brand/README.md) are the
signed snapshot taken from that project on 2026-08-26; the brand bundle still governs the mark,
wordmark, state family, and voice. Recreate the design in the production stack; do not port
prototype markup or `support.js`.

Where the tracked handoff and the newer design system disagree, the design system wins. See
"Design authority" below for what that changes and what is still to be synced.

The system presents the same daemon-owned objects across desktop, browser, tablet, and phone:
machine, project, session, turn, artifact, and annotation. State remains consistent across
clients, consequential decisions are attributed to their originating client, and smaller
surfaces collapse information rather than silently removing it.

## Design authority

Recorded 2026-09-02, resolving the two conflicts the repository audit raised.

**The Claude Design system governs.** Its readme, tokens, and specimen cards are the contract. The
signed `.dc.html` surfaces decide anything the design system does not state, including dock tabs,
sidebar groups, and approval labels. The tracked handoff README is the oldest of the three and
loses to both where they disagree.

**Shell geometry follows the design system, not the tracked handoff README.**

| Region | Design system | Tracked handoff README |
| --- | --- | --- |
| Rail | 62px, never collapses | not present |
| Sidebar | 240px | 200 to 420px, collapsing to a 46px icon rail |
| Thread lane | 760px centred | 620px centred |
| Inspector | 280px | resizable dock |
| Titlebar | 38px | unstated |
| Header | 62px | unstated |
| Control height | 34px | unstated |
| Touch target | 44px minimum | 44pt iOS, 48dp Android |

Other design-system rules that supersede the tracked handoff: theme scoping is `.theme-dark` and
`.theme-light` with a dark `:root` default rather than `.dv-dark` and `.dv-light`; spacing is a
literal named scale with compound paddings rather than a 4px grid; motion is `dv-pop-in`,
`dv-pulse`, `dv-sweep`, and `dv-blink` at 90, 140, 200, and 320ms, collapsing to 0.01ms under
reduced motion; product sans type never exceeds 20px (`--text-title`) or falls below 10.5px
(`--text-micro`), while mono sits one notch below its sans sibling and bottoms out at 10px
(`--text-mono-xs`) for machine metadata; icons are Lucide at 1.5px
stroke, 16px in rows and toolbars, 20px in the rail, 24px in empty states; cards carry a one pixel
border and no shadow, with shadows reserved for menu, popover, dialog, and window elevations.

`design/REVISIONS.json` records a SHA-256 and a byte count for every file under `design/`, and
`pnpm release:invariants` fails when the tree and the record disagree. That detects drift, not
tampering: `pnpm design:revision` re-records whatever is on disk, so the check proves the tree
matches what someone recorded on purpose. A diff touching both `design/` and `REVISIONS.json`
is what a reviewer should look at. Verifying the handoff against a signature from Claude Design
would close that gap and is not something this record claims to do.

**The design system is vendored** at `design/design_system_domovoi/`: `styles.css` and the nine
token files, pulled from the project on 2026-09-02. Those files are the token contract; this
section covers what they do not state.

**Still to sync.** Measured against the vendored tokens on 2026-09-02:

- `--faint` has drifted. The design system sets `oklch(0.53 0.01 285)` for dark; production ships
  `oklch(0.59 0.01 285)` in `packages/ui/src/styles.css`. Machine metadata reads lighter than
  intended.
- Seven tokens are absent from production: `--desk`, `--overlay`, `--danger-on`, and the whole
  `--info-bg`, `--info-border`, `--info-fg`, `--info-dim` ramp. The info ramp is what a handoff
  receipt should fill with, which is why those surfaces currently approximate with a translucent
  accent.
- Production matches the design system on the other 39 dark tokens, counting the ten it expresses
  as `var()` aliases.
- The live desktop surface restyles the terminal pane: command rows take a two pixel primary
  left edge over an eight percent primary wash, failure rows sit in a ten percent destructive
  band, and the header and footer bars use the sidebar token.
- Production still implements the tracked handoff geometry rather than the numbers above. Aligning
  the shell is tracked in `ROADMAP.md`, not done.

## Colors

Dark and light themes use the exact OKLCH ramps documented in the handoff. The primary violet
marks active or selected objects. Green means running, reachable, or passing. Amber means waiting
for the user, Auto enabled, or pending approval. Red means a hard refusal, offline state, or
destructive action. Blue identifies handoffs and system notes. Status meaning must never rely on
color alone.

Filled approval, danger, and information regions use their complete background, border,
foreground, and dim ramps from the handoff instead of translucent accent substitutions.

## Typography

Instrument Sans is the UI and prose family. JetBrains Mono is reserved for machine-produced
content: paths, commands, model identifiers, SHAs, selectors, counts, machine names, and timings.
Android replaces Instrument Sans with Roboto while retaining the mono family.

Desktop body text is 12.5–13px with a 1.6–1.72 line height. Window and section titles are 17px at
600 weight. Screen titles on phone and tablet are 26px at 600 weight. Machine metadata is
10–11px mono. Micro-labels are 8.5–10px uppercase with deliberate tracking.

## Layout

Shell geometry comes from `design/design_system_domovoi/tokens/spacing.css` and the table in
"Design authority" above: a 62px rail that never collapses, a 240px sidebar, a 760px thread lane,
a 280px inspector, and the fixed chrome heights. Those values supersede the resizable sidebar and
620px thread column the tracked handoff README describes.

Everything the tokens do not fix still comes from the handoff: pane collapse order, resizing
behavior, and the platform adaptations. Browser promotes preview work, tablet promotes
side-by-side artifact review, and phone promotes approvals while retaining preview, annotation,
fleet, session, and terminal workflows.

Spacing is the literal named scale in `tokens/spacing.css`, not a 4px grid: if a value is 5px it
stays 5px. The compound paddings that recur are named there too. Touch targets stay at the
platform floor, 44pt on iOS and 48dp on Android. Container-responsive controls use measured
container width where resizable panes make viewport media queries insufficient.

## Elevation & Depth

The system is primarily separated by tonal surfaces and one-pixel borders. Floating popovers,
dialogs, and elevated transient surfaces use the documented medium, large, and extra-large
shadow tokens. Status tints use `color-mix(in oklab, ...)` so dark and light themes remain
semantically aligned.

## Shapes

Radii come from `design/design_system_domovoi/tokens/radii.css`. All standard controls derive from
the 0.65rem base: cards and popovers use the base radius, and the steps below it subtract two to
six pixels. Panels use `--radius-xl` at 14px, which is also the window frame. Pills, dots, and
avatars use `--radius-pill`. Device frames follow the exact platform values in the handoff and are
reference framing rather than application components.

## Components

Use shadcn/ui components on Radix primitives for buttons, inputs, popovers, dropdowns, tabs,
switches, segmented controls, dialogs, sheets, and tooltips. Specialized preview, terminal,
diff, annotation, and resize surfaces share the same semantic tokens and accessibility model.

The approval card is the primary safety component. It must expose the exact operation and all
seven decision facts, checkpoint before consequential work, provide scoped decisions, and write
an attributed receipt. Provider, model, reasoning, permission mode, and Auto are separate
controls because they represent separate decisions.

Preview documents remain sandboxed artifacts. Annotation anchors carry selector, text quote,
bounding box, and screenshot crop fallbacks. Resizable regions use pointer capture, explicit
clamps, touch-safe hit areas, and persisted dimensions.

## Brand

Use mark direction 01, "The spirit." Full and reduced forms are separate SVG assets using
`currentColor`; never shrink the full face below 28px. The install icon uses neutral Watching.
Dynamic Idle, Working, and Waiting variants belong only in tray, taskbar badge, and notification
contexts defined by the brand handoff. In-product chrome uses the neutral mark and ordinary status
indicators.

The wordmark is Instrument Sans 600 at `-0.025em`. Write `Domovoi` in prose and `domovoi` for the
binary, packages, and domain. Do not abbreviate it. Voice states mechanisms and limits with plain
punctuation. Never use "control plane," unexplained security claims, exclamation marks, or
account-free promises.

## Do's and Don'ts

### Do

- **Do** treat every file in the Claude handoff as normative unless it explicitly says WIP.
- **Do** use the chosen spirit geometry and size-specific assets from the brand handoff.
- **Do** implement from the foundations and interaction contracts using React, Tailwind v4,
  shadcn/ui, and Radix.
- **Do** preserve realistic long labels, paths, commands, states, and failure cases.
- **Do** keep provider credentials on the execution machine and show their actual source.
- **Do** attribute approvals, annotations, handoffs, and other consequential decisions.

### Don't

- **Don't** use the retired local Design Studio variants as implementation references.
- **Don't** port the prototype runtime, inline styles, Unicode icon stand-ins, or Google Fonts
  requests into production.
- **Don't** implement the public site from its current prototype; the handoff marks it unfinished.
- **Don't** resolve the documented open product questions through incidental UI implementation.
- **Don't** claim model handoffs carry hidden reasoning, provider caches, or native session state.
- **Don't** turn the spirit into a speaking mascot or add cottages, folk ornament, or decorative
  semantic colors.
