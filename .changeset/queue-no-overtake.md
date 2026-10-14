---
"@getdomovoi/ui": patch
"@getdomovoi/web": patch
"@getdomovoi/desktop": patch
---

A new message no longer overtakes a queued message that is waiting to leave on an idle session,
while the release waits for the skill catalog or for its own catalog read for images. Send stays
off until the queued message has left, a line beside Send says the queued message sends first, and
the new draft stays in the composer. A held message does not hold new messages back, and
unqueueing the waiting message turns Send back on.
