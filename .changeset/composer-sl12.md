---
"@getdomovoi/ui": patch
"@getdomovoi/web": patch
"@getdomovoi/desktop": patch
---

The composer reads whether the session's model takes images. When its harness reports that it
takes none, image chips turn red, a notice says how many images cannot go to the model with Remove
and Change model, send stays off, and the attach menu locks the device source. When the harness
has not said, nothing locks and a line says it is not known.

`/checkpoint` takes a checkpoint from the composer, with an optional label, during a turn as well
as between turns.

Attachment chips are pills with a badge per kind and say where each item is read from, with a
`+N more` after three. The prompt editor shows the same chips and removes from the same draft.

The preview variant chosen with Build on this, which rides every send of the session, is shown as
a chip in the composer and the prompt editor, and Unpick on the chip clears it.

The model menu groups models by harness and tags a model that takes no image input. The usage
popover says why it draws a ring or no dial.

A queued message with images for a model that takes none is held whole instead of being sent to
be refused, and a send that failed keeps its attachments, so queueing it again sends them too.
