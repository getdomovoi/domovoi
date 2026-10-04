---
"@getdomovoi/desktop": patch
---

The desktop answers the tailnet switch's status within 15 seconds: the
tailscale status timeout of 10 seconds plus 5. When reading the saved record,
finding the tailscale command or anything else in the read has not finished by
then, a stalled check now reports not known instead of no tailnet: the read is
refused with "The desktop did not answer.", as the card's own deadline does, so
the card keeps its last known report or says Not known, and does not lock the
switch. Automatic reads, "Check again" and the read after a change are all
bounded this way. The status a turn-off reports once it is done still waits for
its read. Status reads asked for between the same two changes share one: a
read asked for while another is under way, before or after that one's
deadline, waits on it under its own deadline instead of starting another. A
read asked for once a change has started or ended starts its own. A read
refused at its deadline stays refused. The deadline cancels nothing: finding
the tailscale command, reading files and the tailscale process run on until
they settle, and the process keeps its existing 10 second timeout. The desktop
bridge passes a refusal from the main process to the card without Electron's
"Error invoking remote method" prefix.
