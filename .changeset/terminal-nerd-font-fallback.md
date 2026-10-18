---
"@getdomovoi/ui": patch
---

Draw Nerd Font prompt icons in the desktop and web terminal when the machine has a Nerd Font.

Starship and powerlevel10k prompts print icons from the Unicode private use areas, which JetBrains
Mono does not carry, so they showed as empty boxes. The terminal now lists common Nerd Font faces
(Symbols Nerd Font, JetBrainsMono, MesloLGS, Hack, FiraCode) and the system symbol faces after
JetBrains Mono, and the browser takes each missing glyph from the first one installed. No font is
bundled, so a machine without any of them still shows the boxes. The phone is unchanged: it cannot
use the Mac's fonts and would need a bundled symbol font.
