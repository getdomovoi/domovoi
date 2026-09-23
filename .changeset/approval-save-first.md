---
"@getdomovoi/daemon": patch
---

`approval.resolve` saves the decision before it answers the agent. When the save fails, the daemon answers `daemonPersistenceUnavailableErrorCode` (`-32014`), the agent is not told, no standing rule is created, and the approval stays pending. Before, the agent was allowed to proceed and the caller was told "Internal daemon error", and an "Always in this project" rule the person was told had failed reached disk on the next save. If the save succeeds but the agent cannot be told, the decision is undone with a second save and the approval stays waiting. An emergency stop that lands during the save keeps its denial, and the stale decision is neither applied nor sent. Cached session history shows the new receipt.
