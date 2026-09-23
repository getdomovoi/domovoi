---
"@getdomovoi/daemon": patch
---

A terminal value typed after its name was shown on an idle beat is now redacted. The daemon
releases held terminal output on a short idle beat so a prompt with no newline shows, and until
now forgot what it had released: `export API_KEY=`, a pause, then the value sent the value in
clear to every terminal client and into the replay a rejoining client is handed. The redactor now
keeps what the released text means. A value after a released assignment is dropped up to its
delimiter, with one `[REDACTED]` in its place. A released name or word stays as context so the
separator and value after it are still caught. Nothing is shown twice.
