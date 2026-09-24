---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": minor
---

A person's allow now takes a checkpoint before the agent hears the decision. Allow once and
always allow in this project take one; a denial and a standing rule or Auto allowing a command
take none. The agent is still mid-turn, so the checkpoint is a snapshot: a commit built in a
temporary index and kept under `refs/domovoi/checkpoints/`, with HEAD, the branch, the index and
every file left as they were. The receipt names that checkpoint's commit. If the checkpoint cannot be taken, the
command does not run, the gate stays open and the person is told to decide again. A session with
no worktree records the checkpoint as unavailable.

The receipt also says how long the allowed command ran, as `ranForMs`, once the agent reports the
command's item complete. Gates now carry the provider's `itemId` so the daemon can match that
completion. When the turn ends or the daemon restarts before the item completes, the receipt has
no run time. Session history carries `ranForMs` on approval entries.
