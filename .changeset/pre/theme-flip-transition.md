---
"@getdomovoi/ui": patch
---

The light and dark flip animates: 200ms on `--ease-out` across background-color, border-color,
color, fill, stroke and box-shadow, collapsed to 0.01ms under `prefers-reduced-motion`. It is
transient, not standing: a `dv-theming` class is armed in the same call that changes the theme
and removed after 240ms, so hover backgrounds keep the design system's instant step. The first
paint and a repeat of the same theme do not animate.
