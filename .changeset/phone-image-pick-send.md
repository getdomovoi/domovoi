---
"@getdomovoi/mobile": patch
---

Keep an image that is still being resized with the turn and session it was picked for.

A large image is resized after the picker closes, while the composer takes taps again. Send now
waits for it with a line saying so, instead of sending the words without it and leaving it for
the next turn. Leaving the session drops a pick that finishes later, as leaving already drops
picked images, and a send removes only the images it sent.
