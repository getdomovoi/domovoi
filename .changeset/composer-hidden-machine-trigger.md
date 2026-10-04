---
"@getdomovoi/ui": patch
---

The composer no longer holds an invisible control that Tab and screen readers could reach. The
machine menu trigger it keeps mounted, so the sessions drawer's "Move to another machine" can open
the menu, is now inert, out of the tab order and hidden from assistive technology. When the menu
closes, or a pairing or move dialog it opened closes, focus returns to where it was when the drawer
opened the menu, or to the message field, rather than to the hidden trigger.
