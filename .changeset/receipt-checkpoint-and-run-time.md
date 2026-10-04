---
"@getdomovoi/ui": patch
---

The decision receipt for an allow names the checkpoint the daemon took before the command and how
long the command ran, as the design draws it: "Checkpoint abcdef10 was taken first, then it ran in
38s", with the short commit and run time beside the title. The commit is shortened to the same 8
characters as the checkpoint's row in the thread. It names the checkpoint only when the
thread shows that checkpoint taken at the decision, so a receipt from before the daemon took one
keeps "Recorded against". The run time appears once the daemon reports it.
