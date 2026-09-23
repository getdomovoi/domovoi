---
"@getdomovoi/ui": patch
---

Keep the unsent draft when the person switches sessions. The shell keys the thread on the active session, so a switch remounts it. That reset is correct for the pending send, the error alerts and the transfer receipt, and it stays. It was not correct for the half-written turn, which was thrown away with everything else.

A bounded per-session draft store now holds the prompt, the staged attachments, the selected skills and the open prompt editor outside the component, so a switch and a switch back returns what was typed. Drafts stay separate per session, an empty draft is stored as no draft at all, and the store keeps at most twenty sessions, dropping the least recently written, so a long session list cannot grow it without end. Sending clears the draft, because the cleared prompt writes an empty one.
