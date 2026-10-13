---
"@getdomovoi/daemon": patch
---

Bound approval card identity reads and path settlement to one lookup deadline. Seal cards with hidden paths when identity reads time out or fail, and ignore late results.

Retain an unreadable identity after a failed raise read so the first Allow requires review of the newly read target.
