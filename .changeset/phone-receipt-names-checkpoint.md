---
"@getdomovoi/mobile": patch
---

A decision receipt on the phone now names the checkpoint the daemon took before an allowed command,
by its commit, and how long the command ran once it finishes: Checkpoint 8f3c1de was taken first,
then it ran in 12s. The run time comes from the receipt's ranForMs. The time the gate waited for an
answer, which the receipt used to label Duration, is now Decided after. RECORDED AS lists the
decision, the client it was decided on, the checkpoint and that wait as rows. A legacy receipt's
client id is listed as Declared client, because it is what the client's hello declared and no
credential vouches for it. A phone decision recorded over a verified connection says the audit row
names its verified credential rather than its label. A deny no longer wears the success colours and
never claims a checkpoint was taken.
