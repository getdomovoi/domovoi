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

The normative product-design source is the Claude Design handoff under
[`design/design_handoff_domovoi/`](design/design_handoff_domovoi/README.md). The companion
[`design/design_handoff_domovoi_brand/`](design/design_handoff_domovoi_brand/README.md) governs
the mark, wordmark, state family, and voice. Product tokens remain the color authority. Recreate
both handoffs in the production stack; do not port prototype markup or `support.js`.

The system presents the same daemon-owned objects across desktop, browser, tablet, and phone:
machine, project, session, turn, artifact, and annotation. State remains consistent across
clients, consequential decisions are attributed to their originating client, and smaller
surfaces collapse information rather than silently removing it.

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

Implement the surface shells, panes, collapse order, resizing behavior, and platform-specific
adaptations exactly as documented in the handoff. Desktop uses custom window decoration and its
specified resizable workspace. Browser promotes preview work. Tablet promotes side-by-side
artifact review. Phone promotes approvals while retaining preview, annotation, fleet, session,
and terminal workflows.

Spacing follows a 4px base. Desktop rows are 28px, browser rows 30px, tablet targets at least
44px, and phone targets at least 44pt on iOS or 48dp on Android. Container-responsive controls
use measured container width where resizable panes make viewport media queries insufficient.

## Elevation & Depth

The system is primarily separated by tonal surfaces and one-pixel borders. Floating popovers,
dialogs, and elevated transient surfaces use the documented medium, large, and extra-large
shadow tokens. Status tints use `color-mix(in oklab, ...)` so dark and light themes remain
semantically aligned.

## Shapes

All standard controls derive from the 0.65rem base radius. Cards, panels, and popovers use the
base radius; tracks, inputs, chips, tabs, and buttons subtract two to four pixels. Pills, dots,
and avatars use fully rounded geometry. Device frames follow the exact platform values in the
handoff and are reference framing rather than application components.

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
