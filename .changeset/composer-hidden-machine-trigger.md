---
"@getdomovoi/ui": patch
---

The composer no longer holds an invisible control that Tab and screen readers could reach. The
machine menu trigger it keeps mounted, so the sessions drawer's "Move to another machine" can open
the menu, is now inert, out of the tab order and hidden from assistive technology.
