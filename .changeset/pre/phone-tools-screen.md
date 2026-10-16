---
"@getdomovoi/mobile": minor
---

The phone has a Tools screen, opened from the connected machine's card on Machines. It reads
`tool.inventory` and shows what the open repository holds back, every entry grouped by the file
that declared it, with the reason each is held back and the repository's trust state. A file that
could not be read is named with its reason, and entries the daemon left out are counted, so the
list never reads as whole when it is not. A repository that cannot be trusted lists why. A footer
says trust is granted from desktop or web; the phone has no control that trusts or takes trust
back.
