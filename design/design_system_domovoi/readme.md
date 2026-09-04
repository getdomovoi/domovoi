# Domovoi Design System

Design system for **Domovoi**, a local-first runner for AI coding agents.

Domovoi gives one interface for running, watching, reviewing and steering coding agents
across local computers, WSL distributions and remote development servers. Each machine
runs a headless daemon; desktop, browser, phone and tablet clients connect to it. Code,
credentials, terminal processes and Git state stay on the machine doing the work.

- Domain `domovoi.sh` · GitHub org `getdomovoi` · CLI `domovoi`
- Tagline: "A good spirit lives in your machines."
- Open core under Apache 2.0, with optional paid hosted services.

## Sources

This system was derived from the product, technical and operational requirements supplied
in this project, and from the six product surfaces designed against them. There was **no
external codebase, Figma file or existing brand kit** — no repository was connected and no
design file was attached. Everything here was authored in-project.

The canonical interactive designs live at the project root and are the source of truth for
anything this system does not spell out:

| File | Surface |
|---|---|
| `Domovoi Desktop.dc.html` | Desktop app (Windows, macOS, Linux) — the most complete surface |
| `Domovoi Web.dc.html` | Hosted browser client |
| `Domovoi Tablet.dc.html` | iPad and Android tablet |
| `Domovoi Mobile.dc.html` | iPhone and Android phone |
| `Domovoi Site.dc.html` | Public marketing site (work in progress) |
| `Domovoi Foundations.dc.html` | Token, primitive and IA reference |
| `Domovoi Brand.dc.html` | Mark exploration and brand rules |

## Content fundamentals

The product's argument is that it is trustworthy with your machines. Every word has to
survive an engineer asking "how do you know?"

1. **State the mechanism, not the feeling.** A mechanism can be evaluated; a feeling cannot.
2. **Name the limit in the same breath as the promise.** A handoff carries the thread,
   plan and worktree. It does not carry hidden reasoning. Both halves ship together.
3. **Say what is not decided.** Where behaviour is unsettled, say so rather than implying
   a guarantee. This is what earns the security claims.
4. **Plain punctuation.** Short sentences. No em dashes anywhere. Mono for anything a
   machine produced. No exclamation marks in the product.

Banned: "control plane", "runs with no account", em dashes, emoji, exclamation marks in
product copy, and "seamless", "effortless", "magical", "just works".

`Domovoi` in prose. `domovoi` for the binary, packages and the domain. Sentence case for
every heading, label and button; uppercase only in eyebrows and mono status badges.

Product data must be realistic. Never `Lorem ipsum`, never `Task 1`. Show offline machines,
failed runs, providers needing auth, and blocked tests: the product's value is visible only
when something is wrong.

## Visual foundations

**Colour.** The shadcn/ui token contract plus `--success`, `--warning`, `--info`, `--faint`,
the `--strong` / `--code` / `--desk` / `--overlay` neutrals, and the `--warn-*`, `--danger-*`
and `--info-*` state ramps. Every value is `oklch`. Dark is the default and light is the same
contract inverted, not a re-skin. One accent: `--primary`. All tints are
`color-mix(in oklab, var(--primary) N%, transparent)`, never a baked alpha.

**Type.** Instrument Sans for the product, JetBrains Mono for anything a machine produced:
paths, commands, shas, model ids, durations, byte counts, host names. If a human wrote it, it
is sans. The app never goes above 20px or below 10.5px.

**Spacing.** Not a 4/8 grid. Literal values that repeat. If a value is 5px, it is 5px.
Fixed chrome is tokenised: `--h-titlebar` 38, `--h-header` 62, `--h-control` 34, `--h-tap` 44,
`--w-rail` 62, `--w-sidebar` 240, `--w-inspector` 280.

**Layout.** Rail, then panels, then content. The thread lane is centred at 760px with user
messages right-aligned. Every group of siblings is flex or grid with `gap`.

**Backgrounds.** Flat tokens only. No gradient backgrounds, imagery behind text, patterns or
noise. The one gradient is the composer fade.

**Borders and elevation.** Everything is a 1px `--border`. Cards get a border and no shadow.
Shadows belong only to floating surfaces.

**Motion.** Functional only: `dv-pop-in`, `dv-pulse`, `dv-sweep`, `dv-blink` at 90/140/200/320ms.
No bounce, parallax, scroll-triggered reveals or decorative loops. `prefers-reduced-motion`
collapses everything to 0.01ms.

**Interaction.** Hover steps one neutral. Press has no scale. Focus is `2px solid var(--ring)`
at 2px offset and is never removed. Disabled is 40-45% opacity; offline machines dim to 55%
and stay visible, because the fleet is the point.

## Iconography

There is no icon set in this project. Adopt **Lucide** (`lucide-react`, 1.5px stroke, 24px
grid), which is what shadcn/ui assumes. One set, one stroke weight, no mixing filled and
outline. Icons are `--muted-foreground` by default and `--foreground` when active. 16px in
rows and toolbars, 20px in the rail, 24px in empty states. No emoji, ever.

Status is a `StatusDot`, not an icon: colour plus an adjacent text label, never colour alone.

The Domovoi mark is not an icon and appears once per surface. Its paths are
`fill="currentColor"`, so it must be inlined or drawn with a CSS mask. Referencing it with
`<img src>` paints it black and makes the four state variants indistinguishable.

## Component inventory

Derived from the six designed surfaces, not from a generic primitive checklist. There is no
Tooltip, Accordion, Avatar or Toast component because no surface uses one.

- `controls/` Button, IconButton, Input, Textarea, Switch, SegmentedControl
- `display/` StatusDot, Badge, Pill, Mono, Eyebrow, Kbd, ProgressSweep
- `surfaces/` Card, Panel, Popover, MenuItem, Dialog
- `product/` ApprovalCard, MachineChip, ModelChip, PermissionMode, SessionRow, DiffFileRow,
  HandoffReceipt, OfflineBanner, AnnotationThread, SkillCard, PreviewToolbar

Each component directory carries `<Name>.jsx`, `<Name>.d.ts`, `<Name>.prompt.md` and one card
HTML in the design project. Read the `.prompt.md` before using a component: several carry
product rules that are not obvious from the props.

## Caveats

1. Font files are not bundled; `tokens/fonts.css` pulls from Google Fonts.
2. No icon set. Lucide is the recommendation.
3. The public site is a work in progress.
4. The mark is a buildable v1, not a finished master.
5. Component cards are static mirrors; the `.jsx` files are the implementation.
6. Four product decisions are open in the project's `HANDOFF-NOTES.md`: machine transfer to
   an offline target, what the handoff UI may promise, the skill install trust model, and
   guest browser session scope.
