---
"@getdomovoi/mobile": patch
"@getdomovoi/desktop": patch
"@getdomovoi/web": patch
---

Generate the app icons and the splash from the mark instead of shipping a hand-made tile.

The shipped tile carried an amber radial glow and the full mark at roughly 40 percent of the
tile. `scripts/brand-icons.mjs` now renders every asset from
`design/assets/mark-reduced.svg` and `design/assets/mark.svg` with a local Chromium that cannot
reach the network. Colours come from `apps/mobile/src/theme/tokens.generated.js`, so the artwork
and the phone read one palette.

iOS, Android, splash and favicon follow the root file "Domovoi App Icon.dc.html" in Claude Design
project a3b4404e-4d0c-451e-8dd2-203116a76c06, read 2026-09-25, candidate "ink", the file's
default. The icon is the reduced mark at 60 percent of the tile in `--primary` on `--card`, a
full-bleed square with no baked radius because the OS applies its own mask, and no alpha. The
Android adaptive foreground is the glyph on transparency, inset for the mask, with the ground as
a flat colour in the config. The splash is the full mark at 76pt in `--primary` on `--background`
for each theme, with no wordmark. The favicon is the reduced mark at 48px on the same ground.

macOS does not mask app icons, and the App Icon file does not cover it. The desktop build for
macOS therefore uses the brand handoff's macOS rule: the same ink tile as a squircle with a 22
percent radius on Apple's 824 of 1024 grid. Windows and Linux keep the full-bleed square. The web
app icons are generated from the same script with the same ink ground.

The mobile app had no icon or splash configured before this change.
