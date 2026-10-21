---
"@getdomovoi/ui": patch
"@getdomovoi/web": patch
"@getdomovoi/desktop": patch
---

The queue release no longer sends a queued message with images to a session whose model's harness
reports no image input, including a session that is not on screen and a turn that ends in the same
update as the model's answer. The message stays queued and held with the composer's notice. A
message with images waits for the release's own catalog read before it goes; a model that has not
said whether it takes images, or a read that fails, does not hold it. Text-only messages are
unaffected.
