---
"@getdomovoi/ui": patch
---

Answer a send straight away instead of after the round trip. The composer used to hold the typed words, disabled, until the daemon replied, and the request budget is 120 seconds, so that was the worst case silent window. The queue path already cleared the box on the press, which left the interaction where less had happened looking like the faster one.

The composer now empties on the press and the message appears beside it as a sending note until the daemon answers. The note is local and is never a thread item, so the daemon stays the only owner of thread state and no local row can stand beside the real one. A refused send puts the words back, unless the person has already typed something newer, which is kept instead.
