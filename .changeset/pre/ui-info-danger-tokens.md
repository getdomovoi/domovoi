---
"@getdomovoi/ui": patch
---

The approval receipt, the plan strip, the policy refusal card and the danger and info chips draw their tinted frame and header again. The info and danger colour families were used by name but never registered with the sheet, so the utilities produced no CSS and the header text took the on-solid contrast colour, which vanishes against the page.
