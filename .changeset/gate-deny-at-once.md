---
"@getdomovoi/ui": patch
---

Deny on the approval card now decides at once, as the design draws it. A quieter "Deny with a note"
opens a field for a note that is kept on the receipt; its copy says the agent is told only that you
denied it, because no provider receives the note. The receipt reads "Denied with a note". The card
sends one decision at a time: a double click sends one, and every decision waits until the daemon
has answered, so a repeat press cannot decide the next gate drawn in the same place. While it waits,
the card says "Sending your decision".
