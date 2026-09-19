---
"@getdomovoi/mobile": patch
---

Generate the app icon and the splash from the mark instead of shipping a hand-made tile.

The shipped desktop tile carried an amber radial glow the design never draws and the design system
bans, the mark at roughly 40 percent of the tile where the specification is 60, and a near black
ground where the specification is `--card`. It also used the full mark, whose mustache is a four
pixel curve at 60px and is gone at 40, so the face turned to mud at the sizes the operating system
actually draws.

`scripts/brand-icons.mjs` renders every asset from `design/assets/mark-reduced.svg` and
`design/assets/mark.svg` with a local Chromium: a flat square with no radius, no glow, no shadow
and no alpha, because iOS and Android apply their own shape mask and a baked radius produces a
double edge. Colours come from `apps/mobile/src/theme/tokens.generated.js` rather than from
literals, so the artwork and the phone read one palette.

The mobile app had no icon or splash configured at all. It now ships `icon.png`,
`adaptive-icon.png` with the Android ground as a colour, `favicon.png`, and a splash that is the
full mark at 76pt in `--primary` on `--background` in both themes, since Expo picks the asset by
appearance rather than recolouring one.
