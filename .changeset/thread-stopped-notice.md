---
"@getdomovoi/ui": patch
---

After you stop the agent and its turn ends, the thread shows a notice above it: "Stopped. The turn
ended. The next message you send starts the next turn.", with the time and "from this client". It
stands in for the design's paused notice, since the daemon holds no paused state, and it goes away
when another turn starts.
