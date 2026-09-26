---
"@getdomovoi/daemon": patch
---

The Codex sandbox notice now also names the files in the repository history that match the denied
patterns, with "Codex can still read these through Git", because the sandbox refuses the file on
disk but not a committed copy. The history scan is bounded to 1,000 matching commits, 3 seconds and
256 KiB of output; a scan that fails or hits a bound lists nothing, and the session still starts.
