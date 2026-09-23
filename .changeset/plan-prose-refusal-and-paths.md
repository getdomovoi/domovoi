---
"@getdomovoi/protocol": patch
"@getdomovoi/ui": patch
---

Report a touched file path exactly as the provider named it. A leading or trailing space is a legal character in a path name, so the previous trim could name a file the provider never did and could fold two distinct paths into one, making the file count wrong. Whitespace alone is still rejected.

Show a refused plan reply. Accepting a plan written as prose now surfaces the failure next to the button instead of returning it to its resting label in silence, and the branch no longer invites a line comment it cannot take.
