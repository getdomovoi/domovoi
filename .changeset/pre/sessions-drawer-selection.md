---
"@getdomovoi/ui": patch
---

Fix three defects in the sessions drawer. Choosing a session from another surface now opens its thread instead of activating it behind the surface that is still on screen. The trigger closes the drawer instead of reopening it. The open session is named with a Current mark and aria-current rather than by background tint alone.
