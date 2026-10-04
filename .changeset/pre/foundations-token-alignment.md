---
"@getdomovoi/ui": patch
---

Align the colour tokens with the Claude Design Foundations page and give the phone generator the
facts it was missing.

`packages/ui/src/styles.css` takes Foundations as drawn. The light neutrals move from the cool
285 hue to the warm 90 hue Foundations uses, the light semantic ramps darken to the contrast the
page states, and `--warn-fill` with `--warn-fill-fg` join both themes. Dark changes in four
places only: `--faint`, the two new tokens, and the `--shadow-lg` alpha.

`scripts/mobile-tokens.mjs` now emits three things React Native needed and could not derive:
`withAlpha` with the fourteen alpha steps the two designs actually use, per-theme shadow objects
for the md, lg and xl steps, and the list of tokens that fall outside sRGB. `AlphaStep` is a
union of the enumerated steps, so an unlisted step fails typecheck while runtime stays forgiving.

`--faint` is recorded as a bounded exception in `packages/ui/src/accessibility.test.tsx`. Both
themes hold AA Large rather than AA, the assertion pins that band on both sides, and a token that
drifts below 3:1 or quietly reaches full AA fails. Anything using `--faint` for essential text
must use `--muted-foreground` instead.
