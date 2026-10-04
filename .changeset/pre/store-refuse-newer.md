---
"@getdomovoi/daemon": patch
---

State written by a newer protocol minor is refused with `NewerWorkspaceStateError`, which names the
path and both versions: "Domovoi state at <path> was written by a newer daemon (protocol <stored>),
and this daemon speaks protocol <daemon>. It was left as it is and this daemon did not start. Run
the newer Domovoi again, or update this one to protocol <stored major.minor> or later." `domovoid`
prints that message and exits 1 instead of a stack, and the desktop's acquisition carries it as the
refusal message instead of the generic profile one.
