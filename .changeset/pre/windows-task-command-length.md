---
"@getdomovoi/daemon": patch
---

Windows install now refuses a command over 261 characters, the limit schtasks applies,
instead of letting a 262-character command through to fail at schtasks after service.json was written.
The refusal names the command's length and its longest path.
