---
"@getdomovoi/mobile": patch
---

Phone receipts, images per model, the sessions list pills and the recorded build basis.

A receipt for an allow that took no checkpoint now says how long the command ran, on its own
line. Before, the run time was drawn only inside the checkpoint sentence, so it was dropped. The
RECORDED AS rows name the decision in words (allow once), Decided on is the paired device's label
the daemon wrote on the receipt, and a Credential row names that paired device by its shortened id.

The phone asks `runtime.models` for the open session's provider and reads `imageInput` for the
session's model. The attach sheet names the model and what its harness reports. A model reported
to take no images locks Photo or screenshot and Take a photo, with the machine that would refuse
them and `attach.image.model_no_input`. Images already queued for such a model lock send, with a
line that names the model and a Remove button that unlocks it. When image input is not known the
phone locks nothing and says it does not know; the daemon still refuses a send the model cannot
take. Change model is not built on the phone.

The sessions list draws the header's need-you count as a warning pill, each group count as a
tinted pill, needs-you cards on the warning ground, and an approval as a gate pill on its card.

A design-studio render names the variant a message told the agent to build on, read from that
message's delivery record, and checks its tab. No client sends a build basis yet, so until one
does the phone keeps saying a marked variant is a bookmark the agent is not told about.
