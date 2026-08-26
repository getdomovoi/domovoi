# Handoff: Domovoi — cross-platform agent runner

## Overview

Domovoi is a local-first runner for AI coding agents. Each machine a user controls runs a
headless Domovoi daemon; desktop, browser, phone and tablet clients connect to those daemons
and render the same sessions. Code, credentials, PTYs, git state and tool execution never leave
the machine doing the work — clients receive structured state, events, diffs, terminal streams
and preview documents over the Domovoi protocol.

This bundle contains the complete product design for six surfaces:

| File | Surface | Design size |
|---|---|---|
| `Domovoi Desktop.dc.html` | Electron desktop app (macOS / Windows / Linux) | 1560×980 window in a desk frame |
| `Domovoi Web.dc.html` | Hosted browser client + tablet-browser variant | 1440×900 browser frame |
| `Domovoi Tablet.dc.html` | iPad and Android tablet app | 1194×834 / 1280×800 |
| `Domovoi Mobile.dc.html` | iPhone and Android phone app | 390×844 / 412×892 |
| `Domovoi Site.dc.html` | Public domovoi.sh marketing site — **WIP, needs iteration** | 1080px content column |
| `Domovoi Foundations.dc.html` | Token, primitive and IA reference | 1240px content column |

Read `Domovoi Foundations.dc.html` first. It is the contract the other five obey.

## About the design files

**These are design references, not production code.** Each `.dc.html` file is a self-contained
HTML prototype that opens in a browser. They exist to show intended layout, hierarchy, state
and behavior at high fidelity.

Do not port the markup. The task is to **recreate these designs in the target codebase** using
its established stack and patterns. The intended stack for Domovoi is already decided:

- TypeScript monorepo, pnpm workspaces, strict TS
- React, shared application architecture across Electron and browser
- **Tailwind CSS v4** with **shadcn/ui** components on **Radix** primitives
- Electron for desktop (custom window decoration, native keychain, native notifications)
- Node daemon, WebSocket + JSON-RPC, node-pty, xterm.js in clients
- PWA for the browser client; native shells for iOS and Android

Because the target stack is shadcn/ui, the prototypes were authored **against the shadcn token
contract on purpose**. Token names in the HTML map 1:1 onto a shadcn `globals.css` theme block.
Port the tokens first, then build screens from shadcn components — do not hand-roll popovers,
dropdowns, tabs, switches, dialogs or tooltips.

A note on prototype mechanics you should ignore: these files use inline styles and a small
render runtime (`designs/support.js`) so they stream and paint progressively in the design tool.
That is a constraint of the prototyping environment, not a design decision. In the real app,
use Tailwind utility classes and component variants.

## Fidelity

**High fidelity.** Colors, type sizes, spacing, radii, border treatments, hover and active
states, empty and error states, and copy are all final and intentional. Match them.

Two caveats:

1. **Product screenshots are placeholders.** Anywhere you see a diagonal hatch fill labeled
   `[ product shot · … ]`, that is a slot for a real capture. The public site has four; the
   preview panes in the app surfaces use them to stand in for sandboxed artifact renders.
2. **Data is realistic but invented.** Machine names (`macbook-pro-m3`, `hetzner-cx42`,
   `Ubuntu-24.04 · WSL`, `studio-arch`, `win-desk`), session titles, commit SHAs, costs and
   timings are written to be plausible at the right length. Keep the *lengths* when you build —
   the layouts were tuned against long session titles, not short ones.

## Design tokens

### Color

Tokens live in a theme class (`.dv-dark` / `.dv-light` in the prototypes) and resolve to
`oklch()` values. Port them as the shadcn theme block. Every token below is referenced by at
least one surface.

**Standard shadcn tokens** — use the shadcn names exactly:

| Token | Dark | Light |
|---|---|---|
| `--background` | `oklch(0.165 0.005 285)` | `oklch(0.995 0.001 285)` |
| `--foreground` | `oklch(0.96 0.003 285)` | `oklch(0.22 0.01 285)` |
| `--card` | `oklch(0.205 0.006 285)` | `oklch(1 0 0)` |
| `--card-foreground` | = `--foreground` | = `--foreground` |
| `--popover` | = `--card` | = `--card` |
| `--popover-foreground` | = `--foreground` | = `--foreground` |
| `--primary` | `oklch(0.72 0.17 275)` | `oklch(0.52 0.2 275)` |
| `--primary-foreground` | `oklch(0.17 0.03 275)` | `oklch(0.99 0.005 275)` |
| `--secondary` | = `--accent` | = `--accent` |
| `--secondary-foreground` | = `--strong` | = `--strong` |
| `--muted` | `oklch(0.265 0.007 285)` | `oklch(0.935 0.005 285)` |
| `--muted-foreground` | `oklch(0.66 0.01 285)` | `oklch(0.5 0.012 285)` |
| `--accent` | `oklch(0.235 0.006 285)` | `oklch(0.955 0.004 285)` |
| `--accent-foreground` | = `--foreground` | = `--foreground` |
| `--destructive` | `oklch(0.63 0.19 25)` | `oklch(0.55 0.2 25)` |
| `--destructive-foreground` | `oklch(0.98 0.01 25)` | `oklch(0.99 0.01 25)` |
| `--border` | `oklch(0.305 0.008 285)` | `oklch(0.9 0.006 285)` |
| `--input` | = `--border` | = `--border` |
| `--ring` | = `--primary` | = `--primary` |
| `--sidebar` | `oklch(0.185 0.005 285)` | `oklch(0.975 0.003 285)` |
| `--sidebar-foreground` | = `--strong` | = `--strong` |
| `--sidebar-border` | = `--border` | = `--border` |
| `--radius` | `0.65rem` | `0.65rem` |

**Domovoi additions.** shadcn names no semantic status colors and only two neutral text steps.
These four groups are deliberate extensions; each has a paired foreground.

| Token | Dark | Light | Used for |
|---|---|---|---|
| `--success` | `oklch(0.75 0.14 158)` | `oklch(0.52 0.13 158)` | running work, reachable machines, passing tests |
| `--success-foreground` | `oklch(0.17 0.03 158)` | `oklch(0.99 0.01 158)` | |
| `--warning` | `oklch(0.79 0.13 62)` | `oklch(0.6 0.13 62)` | waiting on the user, Auto on, pending approval |
| `--warning-foreground` | `oklch(0.2 0.04 62)` | `oklch(0.99 0.01 62)` | |
| `--info` | `oklch(0.72 0.1 240)` | `oklch(0.52 0.14 240)` | handoff receipts, system notes |
| `--info-foreground` | `oklch(0.17 0.03 240)` | `oklch(0.99 0.01 240)` | |
| `--strong` | `oklch(0.89 0.003 285)` | `oklch(0.33 0.011 285)` | card titles, one step above muted |
| `--faint` | `oklch(0.53 0.01 285)` | `oklch(0.63 0.011 285)` | machine metadata, one step below muted |
| `--code` | `oklch(0.145 0.004 285)` | `oklch(0.972 0.003 285)` | terminal, diff and command surfaces |
| `--desk` | `oklch(0.11 0.004 285)` | `oklch(0.925 0.005 285)` | canvas behind the app frame (prototype only) |
| `--overlay` | `oklch(0.11 0.004 285 / .78)` | `oklch(0.3 0.01 285 / .38)` | modal scrim |

**Filled status regions.** The approval card and offline banner fill a whole region, so a tint
is not enough. Each needs a bg / border / fg / dim ramp:

| Group | Dark bg / border / fg / dim | Light bg / border / fg / dim |
|---|---|---|
| `--warn-*` | `0.235 0.045 62` / `0.38 0.08 62` / `0.94 0.05 68` / `0.76 0.07 62` | `0.975 0.025 85` / `0.86 0.09 75` / `0.38 0.09 62` / `0.52 0.09 62` |
| `--danger-*` | `0.28 0.08 25` / `0.4 0.11 25` / `0.93 0.04 25` / `0.78 0.06 25` | `0.965 0.02 25` / `0.87 0.07 25` / `0.42 0.14 25` / `0.54 0.14 25` |
| `--info-*` | `0.22 0.02 240` / `0.32 0.05 240` / `0.86 0.05 240` / `0.8 0.08 240` | `0.965 0.02 240` / `0.87 0.05 240` / `0.36 0.1 240` / `0.48 0.11 240` |

Also `--warn-bg-deep` (`0.19 0.03 62` dark, `0.945 0.045 85` light) for the nested command row
inside an approval card, and `--danger-on` for text on a filled destructive surface.

**Rule for tints.** Never bake alpha into a status color. Write
`color-mix(in oklab, var(--warning) 18%, transparent)`. This is what allows light mode to invert
without amber washing out. Percentages in use: 9, 10, 14, 16, 18, 20, 22, 30, 35, 40, 45, 55.

**Shadows.** Three steps, tokenized so light mode softens them:
`--shadow-md` (`oklch(0 0 0 / .4)` dark, `oklch(0.2 0.01 285 / .1)` light),
`--shadow-lg` (`/ .55` dark, `/ .16` light), `--shadow-xl` (`/ .8` dark, `/ .2` light).

### Semantic mapping (fixed — do not improvise)

| State | Token |
|---|---|
| Running, work in flight | `--success` + pulse animation |
| Reachable and idle | `--success`, solid |
| Waiting on you | `--warning` |
| Hard gate, refused, offline | `--destructive` |
| Handoff or system note | `--info` |
| Active / selected object | `--primary` |
| Queued, disabled, offline metadata | `--faint` |

### Typography

Two families, one rule: **Instrument Sans** for prose and UI, **JetBrains Mono** for anything a
machine produced (paths, commands, model ids, SHAs, selectors, counts, machine names, timings).
On Android, **Roboto** replaces the sans; mono is unchanged.

| Role | Size / weight | Notes |
|---|---|---|
| Screen title | 26px / 600, `letter-spacing: -.02em` | phone and tablet headers |
| Window / section title | 17px / 600, `-.01em` | |
| Session title | 13–14px / 500 | clamps to 2 lines with `-webkit-line-clamp` |
| Body, messages | 12.5–13px / 400, `line-height: 1.6–1.72` | |
| Metadata | 11px / 400, `--muted-foreground` | |
| Machine text | 10–11px mono, `--strong` | |
| Micro-label | 8.5–10px, `letter-spacing: .08–.16em`, uppercase, `--faint` | section eyebrows |

Body copy uses `text-wrap: pretty`.

### Radius

Everything derives from `--radius: 0.65rem` via `calc()`:

- `var(--radius)` — cards, panels, popovers
- `calc(var(--radius) - 2px)` — segmented control tracks
- `calc(var(--radius) - 3px)` — inputs, chips, tabs
- `calc(var(--radius) - 4px)` — buttons
- `999px` — pills, dots, avatars
- `14px` / `16px` — the larger reference cards on the foundations and site pages
- Device frames: iPhone `44px`, Android phone `30px`, iPad `30px`, Android tablet `20px`

### Spacing and density

4px base. Common gaps: 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 22, 26, 34px.
Panel padding 12–20px; page sections 40–104px apart on the site.

| Surface | Row height / min target |
|---|---|
| Desktop | 28px rows |
| Browser | 30px rows |
| Tablet | 44px targets |
| Phone | 48px targets |

**Never go below the platform floor.** Where a visual element must stay small (an 18px resize
strip), give it an absolutely-positioned inset overlay (`left: -13px; right: -13px`) so the hit
area reaches 44px without changing layout geometry.

### Scrollbars

Themed from tokens: 11px wide, track `color-mix(in oklab, var(--code) 70%, transparent)`, thumb a
vertical gradient of `--border` → `color-mix(in oklab, var(--border) 60%, var(--muted))` with
`border: 3px solid transparent; background-clip: content-box` so it reads as a floating pill.
Hover blends toward `--primary`; active is solid `--primary`. Firefox: `scrollbar-width: thin`
with `scrollbar-color: var(--border) transparent`. **Mobile surfaces hide scrollbars entirely**
(`::-webkit-scrollbar { display: none }`, `scrollbar-width: none`) since touch platforms overlay
their own.

## Information architecture

### Object graph

Navigation on every surface is a path through these six nouns. Nothing else is top level.

- **machine** — a daemon on hardware the user controls (local, WSL, tailnet, SSH, relay).
  Carries OS, arch, Domovoi version, online state, connection type, available providers,
  auth readiness, active sessions, running tools, approval requests, resource state.
- **project** — a repository on one machine, with a permission mode and skill configuration.
- **session** — a thread in an isolated git worktree. Owns provider, model, reasoning level,
  Auto state, changed files, test results, cost.
- **turn** — one exchange: messages, tool calls, approvals, checkpoints.
- **artifact** — generated HTML from a skill, rendered unchanged in a sandbox. Has variants.
- **annotation** — an anchored comment on an artifact, with a thread and open/resolved status.

### Surface shells

| Surface | Shell | Panes | Promotes |
|---|---|---|---|
| Desktop | custom window decoration | 3 + dock | diff review |
| Browser | top app bar | 3 + dock | preview |
| Tablet | top app bar | 2 + wide dock | side-by-side review |
| Phone | tab bar | 1, stacked | approvals |
| Notification | OS surface | none | Allow / Deny |

**Collapse order is identical everywhere:** side panels become icon rails, then the dock becomes
a rail, then the thread narrows. The thread and the artifact are the last two things standing.

### Three invariants

1. **The daemon is the source of truth.** No client holds state the daemon does not have.
   Closing a laptop lid does not end a session. Two clients watching one session see the same
   events in the same order.
2. **Decisions are attributed.** Every approval, annotation and handoff records its originating
   client. The audit log says a migration was allowed *from a phone*.
3. **Collapse, never omit.** A phone shows the same seven approval facts as a 27-inch display,
   stacked instead of tabled. If a fact is worth showing anywhere, it appears everywhere.

## Screens

### 1. Desktop app (`Domovoi Desktop.dc.html`)

A 1560×980 Electron window. Screens are switchable in the prototype via the tab row above the
frame; in the real app they are routes.

**Window chrome.** Custom decoration by default, with a real setting to fall back to system
decoration (Settings → Appearance & window). The prototype renders both. Traffic lights on
macOS left; minimize/maximize/close on Windows and Linux right. The titlebar is a drag region
except over interactive controls.

**Left sidebar** (resizable 200–420px, collapsible to a 46px icon rail).
Header with fleet switcher, search, then session groups as **collapsible dropdown sections**
with a count badge on each (`ACTIVE 3`, `WAITING 1`, `IDLE 2`). Each session row: status dot,
2-line clamped title, then a metadata row of model chip, mode chip, optional `AUTO` chip, and a
right-aligned state label. Machine name in mono beneath. Footer pinned to the bottom: avatar,
name, fleet summary, settings gear.

**Center column.** Session header (title, worktree, file count, model chip, reasoning chip),
then the thread, then the composer.

The thread is a centered 620px column. **User messages align right** in a bubble
(`--accent` fill, `14px 14px 5px 14px` radius) with the user avatar hung outside the column to
the right. **Agent messages align left** with a 24px diamond avatar hung outside to the left, and
their prose is offset left of center while structured blocks — plans, diffs, approval cards,
skill cards — stay centered at full column width. A `mask-image` gradient fades content behind
the composer instead of a hard edge.

The composer is a rounded card: textarea, then a control row with machine chip, skill chip,
prompt-editor expand button, and send. **It is width-responsive** — measured with a
`ResizeObserver`, not a media query, because the sidebar resizes. Below ~520px the labeled
buttons become icon buttons with tooltips. The prompt editor opens a larger modal with a
rich-text / markdown toggle rendered as two icon buttons (`¶` and `</>`), each with its own
description line.

**Right dock** (resizable, collapsible). Tabs: Plan, Changes, Preview, Comments, Terminal,
Session. Diff review is the desktop's promoted surface — unified and split view, per-hunk
staging, file tree with add/modify/delete counts.

**Approval card.** The most important component in the product. Amber frame
(`--warn-bg` fill, `--warn-border`), header with pulsing dot, `HARD GATE` chip where applicable,
the exact command in a `--code` block, then seven facts: machine, agent, mode, directory,
affects, network, estimated duration. Three decisions: `Allow once` (filled `--warning`),
`Always in this project` (outlined), `Deny` (muted outline) plus `Deny and explain`. After a
decision, an inline receipt states what happened, the checkpoint id, and which client decided.

**Model and provider switching.** Model, reasoning level and Auto are **three separate
controls**, because they are three separate decisions. Permission mode is a three-way segmented
control — Ask / Plan / Build — and Auto is a switch beside it, not a fourth mode. Both the model
and reasoning menus are floating popovers (never pushing layout), narrower than the trigger row,
with shadcn popover styling. Switching mid-session offers `Switch here` (continue the thread)
vs `Fork with model` (parallel thread in a new worktree), and only applies at a safe turn
boundary.

**Machine switcher.** The composer machine chip opens a device menu listing the fleet with
status, connection type and active session counts. Offline machines show `UNREACHABLE` and are
unselectable. Selecting a different machine runs a transfer preflight — see OPEN-QUESTIONS.md #1;
this behavior is **not settled**. `+ Pair a machine` closes the menu and opens the pairing flow.

**Skills.** Browse, search, inspect SKILL.md, view provenance, enable/disable, configure per
project. Install by file, by directory, or **by terminal command** (`npx`, `pnpm dlx`, `curl`),
since that is how most skills ship. See OPEN-QUESTIONS.md #3.

**Also included:** launcher, fleet view, terminal (xterm.js), settings (appearance and window,
theme, editor, providers, skills, fleet, notifications), device pairing, first-run setup,
connection failure and recovery states.

**Theme.** Settings → Appearance & window → Theme, as three cards: System / Dark / Light, each
with a mini swatch. System follows `prefers-color-scheme` live via `matchMedia`.

### 2. Public site (`Domovoi Site.dc.html`) — work in progress

> **Do not implement this surface from this file yet.** It is a content inventory with a default
> layout, not a signed-off design. Copy has had one pass, the four product shots are unfilled,
> there is no responsive work below 1080px, and the visual direction still needs to go through
> design-studio for variant comparison. See OPEN-QUESTIONS.md #5. Build the app surfaces first.
>
> **Copy constraint:** do not reintroduce "runs with no account" framing. That is a property of
> backend iteration 1 (no account service yet), not a product promise, and whether it holds
> long-term is undecided. Keep open-core messaging on the license and on credentials staying local.

1080px content column, dark, sectioned: hero with install command, architecture (daemon /
protocol / clients) with the transport preference order (loopback → LAN → tailnet → SSH →
relay), permission modes, BYOK and subscription-CLI providers, preview and annotation workflow,
security boundaries, open-core split (Apache 2.0 core vs optional paid services — see the copy constraint above), install tabs
(shell / npm / Homebrew / AUR / Winget / Docker), platform support matrix, footer.

Four product-shot placeholders. Copy is deliberately plain and specific — no em dashes, no
"control plane", no borrowed phrasing.

### 3. Hosted web client (`Domovoi Web.dc.html`)

1440×900 browser frame with a tab bar. Same three-pane workspace as desktop, minus Electron-only
affordances, plus browser-only concerns:

- Sign-in with **passkeys** as the primary path
- Device fleet, remote session control
- Preview is the **promoted** surface here (not diff review)
- Account: profile, auth methods, paired devices, revoked devices, active browser sessions,
  relay entitlement, usage, billing, subscription, security events, notification preferences
- Device revocation and per-session revoke
- **Guest sessions** — short-lived, revocable, and unable to create standing permission rules.
  Whether a guest may approve a hard gate at all is unresolved (OPEN-QUESTIONS.md #4)

A tablet-browser variant is included, since a borrowed iPad in Safari is a real entry point.

### 4. Tablet app (`Domovoi Tablet.dc.html`)

iPad 1194×834 and Android tablet 1280×800, switchable. Follows the **browser** layout, not a
bespoke one: device status strip, then a browser-style app bar (wordmark, Workspace / Fleet /
Terminal tabs, permission segmented control, Auto switch, approvals pill, pause, avatar).

Two panes plus a wide dock: a 240px session list (resizable 190–340px, collapsible to a 46px
rail) and a centered thread, with review living in the right dock. **Side-by-side variant review
is the tablet's promoted job** — the dock is 400px normally and widens to 720px when side-by-side
is on, auto-collapsing the session list so each variant canvas gets ~344px. Split is on by
default.

Both panes have **touch resize handles**: an 18px strip with a visible grip pill, driven by
pointer events (finger, pencil and trackpad alike), `touch-action: none`, pointer capture so the
drag survives leaving the strip, and a 44px inset hit overlay. The grip turns `--primary` while
dragging. Dock clamps 300–820px (560px minimum when split, so a variant can never drop below
~270px). Toolbar controls are width-responsive: below 440px of dock width the variant chips
collapse to 34×34 `A` / `B` / `C` icon buttons with tooltips; below 380px the `SANDBOXED` chip
becomes a shield glyph.

Dock tabs: Preview, Comments, Plan, Changes. Preview toolbar carries the variant switcher on row
one and side-by-side / element picker / width presets (390 / 768 / 1280) on row two.

### 5. Phone app (`Domovoi Mobile.dc.html`)

iPhone 390×844 and Android 412×892, switchable. Six screens: sessions list with the approval
banner as the point of the screen, approval detail, preview with variant switching and
tap-to-annotate, thread with working plan and handoff receipt, fleet with pairing, and the lock
screen with actionable approval notifications.

Platform differences are structural, not cosmetic:

| | iOS | Android |
|---|---|---|
| Status bar | 42px, notch pill | 30px |
| Back | `‹` chevron | `←` up arrow |
| Nav | tab bar, no indicator | bottom bar, pill indicator on active |
| Font | Instrument Sans | Roboto |
| Notification radius | 18px | 22px |
| Home indicator | yes | no |
| Min target | 44pt | 48dp |

Mobile is **not** a status board. It approves, previews, annotates, resolves, selects a preferred
design, sends "Focus on this design", pauses the fleet and reaches a terminal when needed.

### 6. Foundations (`Domovoi Foundations.dc.html`)

The reference: every token with the Domovoi additions marked `OURS`, the state→token mapping,
type scale, radius scale, per-surface density, live primitives (popover, segmented control,
switch, status atoms, approval card, annotation), the object graph, the surface/shell table, the
three invariants, and the four open questions. Links to all five other surfaces.

## Interactions and behavior

- **Resizable panels** — pointer events with pointer capture, `touch-action: none`, min/max
  clamps, live grip highlight. Persist widths per surface.
- **Collapsible panels** — collapse to a fixed icon rail (46px) that keeps status dots visible.
- **Collapsible session groups** — chevron rotates, count badge always visible even when closed.
- **Popovers and dropdowns** — Radix. Float above content, never push layout. Narrower than the
  trigger row. `--popover` fill, 1px `--border`, `--shadow-lg`, 4px item radius, `--accent`
  hover. Close on outside click, Escape, and on action.
- **Composer responsiveness** — `ResizeObserver` on the composer, not media queries, because a
  sidebar drag changes available width without changing viewport width. Keep hysteresis so the
  buttons don't flicker at the threshold.
- **Approval flow** — approve once / deny / deny with explanation / create a scoped rule. Always
  checkpoint before a consequential action. Record the originating client.
- **Annotation flow** — element picker → anchored comment (selector + text quote + bounding box
  + screenshot crop, as layered fallbacks) → thread → resolve / reopen. Unresolved annotations
  can be handed back to the agent on the next turn.
- **Preview** — sandboxed and isolated per document: no Node access, isolated storage partition,
  blocked permission requests, controlled navigation, restricted bridge. Live reload on artifact
  update, pinning while the agent continues, responsive width presets, zoom and fit, filmstrip
  and side-by-side, full-screen, screenshots.
- **Pulse animation** — `dvPulse`, a 2.4–2.5s expanding ring on status dots, for work in flight
  only. Honor `prefers-reduced-motion`: drop the pulse, keep the color.
- **Fade behind the composer** — `mask-image` gradient, not an opaque overlay, so content scrolls
  under it without a hard edge and without obscuring the last message.
- **Theme** — `matchMedia('(prefers-color-scheme: dark)')` with a live change listener when set
  to System.

## State

Per surface, the state the prototypes model:

- Active screen / route; selected session; selected machine
- Panel widths and collapsed flags (persist)
- Collapsed session groups (persist)
- Permission mode; Auto on/off; model; reasoning level — **per session**, not global. A user
  running OpenRouter in one thread, Codex in another and Kilo in a third must see each thread's
  own model, reasoning and Auto state.
- Approval decisions and their receipts
- Annotation open/resolved sets, including reopened
- Selected variant; side-by-side on/off; element picker armed
- Theme preference (system / dark / light) and OS scheme
- Window decoration preference (custom / system)
- Fleet: per-machine online state, connection type, session and tool counts

## Providers

Subscription-backed CLIs, each owning its own credentials: `claude-code`, `codex`,
`cursor-agent`, `opencode`, `grok`, `kilo`. Direct API: OpenAI, Anthropic, OpenRouter, Google,
any OpenAI-compatible endpoint — keys in the OS keychain on the machine that uses them, never
sent to another client, never held by the relay.

## Assets

No image assets. The prototypes use:

- **Fonts** — Instrument Sans, JetBrains Mono, Roboto (Android surfaces), via Google Fonts
- **Icons** — currently Unicode glyphs (`◈ ◫ ⬡ ⚙ ◎ ⤢ ‹‹ ›› ⛨ ¶ </>`) as stand-ins.
  **Replace these with a real icon set** (Lucide is the shadcn default and the right choice).
  Glyph choices communicate intent only; do not ship them.
- **Product shots** — diagonal hatch placeholders, labeled with intended content and size

## Files

```
screenshots/
  01-desktop-workspace.png      desktop app, workspace with approval + diff
  02-public-site.png            domovoi.sh landing page
  03-web-client.png             hosted browser client
  04-tablet.png                 iPad, side-by-side variant review
  05-phone.png                  iOS/Android phone screens
  06-foundations.png            token and IA reference
designs/
  Domovoi Foundations.dc.html   read first — the token and IA contract
  Domovoi Desktop.dc.html       the largest surface, ~2250 lines
  Domovoi Web.dc.html
  Domovoi Tablet.dc.html
  Domovoi Mobile.dc.html
  Domovoi Site.dc.html
  support.js                    prototype render runtime — do not port
OPEN-QUESTIONS.md               four deferred decisions, each affecting daemon behavior
```

Open any `.dc.html` directly in a browser. `support.js` must sit alongside them.

The screenshots are a quick visual index only. They capture one state per surface at the
prototype's default settings — they do not show hover states, open popovers, alternate screens,
the light theme, or the Android variants. **The HTML files are the source of truth**; open them
to reach every state.

## Before you build

Read `OPEN-QUESTIONS.md`. Four decisions were deliberately left open because they change daemon
behavior rather than pixels: offline machine transfer (queue vs refuse), how loudly a model
handoff must disclose what it cannot carry, the skill install trust model, and guest browser
session scope. The designs show *a* behavior for each so the screens could be drawn — not a
chosen one.

Note also that the **public site is unfinished** (OPEN-QUESTIONS.md #5). The five app and
reference surfaces are ready to build; the marketing site needs a design pass first.
