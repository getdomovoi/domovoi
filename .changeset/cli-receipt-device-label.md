---
"@getdomovoi/cli": patch
---

The decision receipt line in `src/transcript.ts` names the decider by the paired device the
daemon wrote on the receipt, label before client kind, as the web and desktop receipt reads:
`allowed once by dana's phone · phone on mac-mini-m4 · 14:07:11`. A receipt without a device (the
daemon credential, or a row written before the field) keeps the label the caller supplies, and
with none names the client kind alone. Control characters and bidirectional formatting characters
in the label or machine name are shown escaped, so no field can break the line or carry a
directional override into the fields after it. The label, machine name and time are each wrapped
in a first strong isolate and a pop directional isolate (U+2068 and U+2069) that the renderer owns,
so in a viewer that applies bidirectional ordering, right-to-left text in one field cannot change
where a neighbouring field such as the time is drawn. Any isolate in the input is shown escaped, so
the only isolates on the line are the renderer's. No command prints the line yet.
