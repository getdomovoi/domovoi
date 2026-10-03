---
"@getdomovoi/ui": patch
---

The refusal card takes focus only while the person is still where the refused start left them: the document, the loading line its code loaded behind, or the control that opened the start. It waits while focus is still in the closing launcher. Focus the person moved into a text field, an editable region, another control or another dialog while the card's code loaded stays there. The card judges the element that holds focus inside open shadow roots, not only their outermost host, and the shell records the control a start came from the same way, so a field inside a shadow root keeps focus even when its host opened the start. Focus in a frame, or in a shadow host whose closed or empty root the card cannot see into, always stays there.
