---
"@getdomovoi/mobile": patch
---

A decision receipt on the phone now names the checkpoint the daemon took before an allowed command,
by its commit, and how long the command ran once it finishes: Checkpoint 8f3c1de was taken first,
then it ran in 12s. The run time comes from the receipt's ranForMs. The time the gate waited for an
answer, which the receipt used to label Duration, is now Decided after. RECORDED AS lists the
decision, the client it was decided on, the credential, the checkpoint and that wait as rows, and a
phone's receipt says the audit row names its verified credential rather than its label. A deny no
longer wears the success colours and never claims a checkpoint was taken.
