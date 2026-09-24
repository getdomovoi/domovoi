---
"@getdomovoi/mobile": patch
---

Phone and tablet correctness. The app keeps one daemon connection: a wake or Retry while a dial is still connecting no longer opens a second one, and a replaced connection can no longer apply deltas twice or turn the live one into watching. A frame the app cannot read (invalid JSON, a snapshot, delta or fleet that fails the schema, or a hello answer that is not a snapshot) is reported in the connection banner instead of dropped. A render error shows a recoverable screen instead of closing the app.

Pairing keeps the kind the code was issued for. A tablet code greets as a tablet, a code for a desktop, web browser or the command line is refused with what to show instead. A credential with no stored kind, one saved before this change or a token typed into Settings, greets as a phone and, if the daemon refuses that credential, tries once as a tablet and keeps the kind that works. A pairing refusal now names a protocol mismatch (and that the code was not used) or a full device list, instead of calling every code spent.

A watching device says a waiting decision waits on a full-access device, on the tablet session list and the phone's jump pill. The tablet thread shows a policy refusal's rule, who set it, where it applies and the remedy, as the phone does. The tablet shows the connection banner, including the out of date notice. A watching tablet is offered no review controls, and a review that fails to post keeps its draft and says why.
