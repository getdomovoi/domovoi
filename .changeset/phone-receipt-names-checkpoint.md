---
"@getdomovoi/mobile": patch
---

A decision receipt on the phone now names the checkpoint the daemon took before an allowed command,
by its commit, and how long the command ran once it finishes: Checkpoint 8f3c1de was taken first,
then it ran in 12s. The run time comes from the receipt's ranForMs. The receipt used to show the
time the gate waited for an answer under the label Duration, as though it were the run time; that
row is gone. RECORDED AS lists the decision, the client it was decided on and the checkpoint. A deny
no longer wears the success colours and never claims a checkpoint was taken.
