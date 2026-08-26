# Handoff: Domovoi brand identity

## Overview

Brand identity for **Domovoi**, a local-first runner for AI coding agents. This package covers
the mark, its state family, the wordmark, voice, and the constraints that keep the identity
consistent with the product's argument.

Domain `domovoi.sh`. GitHub org `getdomovoi`. Tagline "A good spirit lives in your machines."

This is a **separate handoff from the product design package** (`design_handoff_domovoi`), which
covers the six product surfaces. That package's token tables are the source of truth for colour;
this one governs the mark and the language.

## About the design file

`designs/Domovoi Brand.dc.html` is an interactive reference, not production code. Open it in a
browser. Click any of the six mark cards and the whole page re-renders with that mark — lockups,
app icons, state family and chrome placements — so you can compare directions in context.

Mark **01 "The spirit"** is the chosen direction. The other five are recorded alternates with
their rationale and risk, kept so the decision is auditable rather than reopened.

## Fidelity

**High fidelity, with one honest boundary.**

The chosen mark is real drawn geometry — hand-authored bezier paths, buildable as-is. Ship it as
SVG. Two flat fills, no strokes, no gradients.

An illustrator would still improve it: tighten the beard silhouette and give the mustache real
asymmetry. Treat the paths below as a correct, usable v1 rather than a finished master.

The two alternate spirit marks (03 hooded, 04 capped) are **geometric CSS stand-ins** built only
for silhouette comparison. Do not ship those.

## The mark

### Concept

Hair and beard as one mass, with the **face cut out of it** and the eyes and mustache set back
inside. The face void is what makes the beard read as a beard rather than eyes on a blob.

### Geometry

Two paths on a `0 0 100 100` viewBox.

**Path 1 — mass and face void.** Requires `fill-rule="evenodd"`; the second subpath punches the
face out.

```
M50 4C67 4 79 14 81 31C83 45 88 60 84 73C79 87 66 96 50 96C34 96 21 87 16 73C12 60 17 45 19 31C21 14 33 4 50 4Z
M50 16C60 16 67 22 67 32C67 43 60 51 50 51C40 51 33 43 33 32C33 22 40 16 50 16Z
```

**Path 2 — eyes and mustache.** Default fill rule.

```
M38.7 31a3.3 3.3 0 1 0 6.6 0a3.3 3.3 0 1 0 -6.6 0Z
M54.7 31a3.3 3.3 0 1 0 6.6 0a3.3 3.3 0 1 0 -6.6 0Z
M34 43C40 40 45 43 50 43C55 43 60 40 66 43C59 50 54 47 50 47C46 47 41 50 34 43Z
```

Both paths take the same fill. The mark is monochrome by definition.

### Size behaviour — two forms, one breakpoint

| Rendered size | Form |
|---|---|
| 28px and above | Full: eyes at r 3.3, mustache present |
| Below 28px | Reduced: mustache dropped, eyes opened to r 4.6 and spread to ±9 |
| Below 16px | Do not use. Use the wordmark or a status dot instead |

Reduced-form eye circles, same viewBox:

```
M36.4 32a4.6 4.6 0 1 0 9.2 0a4.6 4.6 0 1 0 -9.2 0Z
M54.4 32a4.6 4.6 0 1 0 9.2 0a4.6 4.6 0 1 0 -9.2 0Z
```

Ship both as separate assets (`mark.svg`, `mark-reduced.svg`) and pick by render size. Do not
scale the full form down — mid-face detail turns to mud below 28px.

### Working state

Working state widens the eyes to r 3.8. Idle replaces each eye circle with a closed lid:

```
M{cx-5.3} 31 q5.3 5.6 10.6 0 q-5.3 -2 -10.6 0 Z
```

## The state family

The silhouette never changes. Only the eyes and the field behind it do. This is the payoff of a
character mark: fleet state readable from the tray before anything is opened.

| State | Meaning | Eyes | Field |
|---|---|---|---|
| Idle | No sessions | Closed lids | Flat `--code`, no glow |
| Watching | Connected, nothing running | Normal | 16% primary glow |
| Working | Tools in flight | Widened (r 3.8) | 34% primary glow |
| Waiting | Approval pending | Normal, body `--warning` | 34% warning glow |

**Hearth glow.** Lower third of the field, never on the mark:

```css
radial-gradient(88% 52% at 50% 100%, color-mix(in oklab, var(--warning) 34%, var(--background)) 0%, var(--background) 76%)
```

The mark stays optically centred so it holds a squircle, a square and a circle alike; the glow
sits low and lights it from below.

### Where state is allowed

| | Surface | Note |
|---|---|---|
| ✓ | Tray / menu bar icon | The one place state earns its keep |
| ✓ | Dock or taskbar badge | Waiting only, with the count. Never Working — it would flicker all day |
| ✓ | Notification avatar | Match the reason: Waiting for approvals, Working for completions |
| ✕ | App icon on disk | Installers, stores and Finder get neutral Watching. A changing Finder icon reads as a bug |
| ✕ | In-product chrome | Inside the app, state belongs to status dots and the approval card |
| ✕ | Marketing and the site | One neutral mark. A logo that winks undercuts the security argument |

## App icons

The mark on a flat field, centred, with the hearth glow in the lower third.

| Target | Size | Shape | Field |
|---|---|---|---|
| macOS | 1024 | Squircle, 22% radius | Glow |
| Windows | 256 | Square | Glow |
| Android | 432 | Adaptive circle | Glow |
| Favicon | 32 | Bare | None — reduced glyph alone |

The favicon drops both glow and field: at 32px a warm haze turns to mud.

## Wordmark

Instrument Sans 600, `letter-spacing: -.025em`. No custom letterforms, no ligature tricks. Nine
characters, unusual enough to carry itself.

Pronounced `/dəməˈvoj/`, stress on the last syllable.

| | Form | Where |
|---|---|---|
| ✓ | `Domovoi` | Prose, product names, titles |
| ✓ | `domovoi` | The binary, packages, the domain — lowercase everywhere it is typed |
| ✓ | `the Domovoi daemon` | Lowercase daemon; it is a common noun |
| ✕ | `DOMOVOI` | Notification channel labels only, never prose |
| ✕ | `Domovoi.sh` | The domain is always lowercase |
| ✕ | `Dom`, `DMV`, `D-voi` | No short forms. If it does not fit, use the mark alone |

Lockups: mark + wordmark at 40/26/20px mark sizes. Below 20px, mark alone.

## Voice

1. **State the mechanism, not the feeling.** "Each machine runs a daemon that holds the session"
   beats "seamless everywhere". The audience can evaluate a mechanism.
2. **Name the limit in the same breath as the promise.** A handoff carries the thread, plan and
   worktree. It does not carry hidden reasoning. Both halves ship together or neither does.
3. **Say what is not decided.** Where behaviour is unsettled, say so rather than implying a
   guarantee. This is what earns the security claims.
4. **Plain punctuation.** No em dashes. Short sentences. Mono for anything a machine produced.
   No exclamation marks anywhere in the product.

### Rewrites

| Instead of | Write | Why |
|---|---|---|
| The AI-powered control plane for your entire dev workflow | One window for the coding agents already on your machines | No borrowed category language. Says what it is and where work happens |
| Runs with no account at all | Bring your own agents and keys | The first is an artifact of backend iteration 1, not a promise. Never market it |
| Seamlessly switch between models mid-conversation | Change model at the next safe turn boundary. Thread, plan and worktree come with it | "Seamless" is unfalsifiable. The real behaviour is more reassuring than the adjective |
| Enterprise-grade security you can trust | The relay carries encrypted payloads it cannot read. Keys stay in your OS keychain | Trust is claimed by describing the boundary, not asserting the adjective |

**Banned phrase.** "Control plane" is out of the vocabulary entirely. Use "agent runner", or
describe the mechanism.

## What the brand does not do

- **No cottages, stoves or ornament.** If the mark is the spirit, that is the whole illustration
  budget. No hearth scenes, no folk borders, no woodcut texture.
- **No gradient in the mark.** The silhouette is flat colour, always. Only the icon field may
  carry the hearth glow, and it never bleeds into the shape. The mark must survive a monochrome
  favicon and a black-and-white print sheet.
- **No second accent colour.** One primary. The other hues are semantic and belong to product
  state: success, warning, destructive, info. Marketing may not borrow them for decoration.
- **No Cyrillic as texture.** Cyrillic section headings were tried and dropped. If Cyrillic
  appears it is because it means something, like the etymology line.
- **A character, not a mascot.** The spirit stays a silhouette in the chrome. It does not gain a
  face in dialogs, speak in first person, or appear in empty states apologising. The audit log is
  the personality.
- **No dark-only lockup.** Every mark and lockup must work on the light theme. The desktop app
  ships both, so the brand cannot assume a dark background.

## Colour

The mark uses `--primary` on `--background`, or `--warning` in the Waiting state. Full token
tables with dark and light values are in the product handoff
(`design_handoff_domovoi/README.md`, Design tokens). Do not define brand-only colours.

## Assets to produce

- `mark.svg` — full form, monochrome, `currentColor`
- `mark-reduced.svg` — sub-28px form
- `mark-idle.svg`, `mark-working.svg`, `mark-waiting.svg` — state variants for the tray
- `wordmark.svg` — Instrument Sans 600 outlined
- `lockup-horizontal.svg` — mark + wordmark
- App icons at the four targets above
- Favicon set from the reduced form

## Files

```
designs/
  Domovoi Brand.dc.html    interactive reference — click any mark to preview it in context
  support.js               prototype render runtime — do not port
screenshots/
  01-brand-directions.png  visual index, default state only
```

The screenshot shows one state. Open the HTML to compare directions and see the state family.
