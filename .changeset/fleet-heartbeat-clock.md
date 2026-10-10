---
"@getdomovoi/ui": patch
---

Measure LAST HEARD against the daemon clock when fleet snapshots include daemon time. Keep the snapshot and receipt-time offset together, continue ticking relative ages, and preserve client-clock behavior for older snapshots.
