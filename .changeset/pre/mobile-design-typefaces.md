---
"@getdomovoi/mobile": patch
"@getdomovoi/ui": patch
---

Ship Instrument Sans and JetBrains Mono inside the phone bundle and register them
before the first frame, with each text style naming its loaded face. The phone's
colours, radii, and font names are now generated from `packages/ui/src/styles.css`,
which gains the design system's desk, overlay, danger-on, and info ramp tokens.
