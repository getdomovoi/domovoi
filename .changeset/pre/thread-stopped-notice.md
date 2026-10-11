---
"@getdomovoi/ui": patch
---

After you stop the agent and the daemon records the pause ("Paused by <client>." in the thread),
the thread shows a notice above it: "Stopped. The turn ended. The next message you send starts the
next turn.", with the time and "from this client". A pause the daemon records as failed shows no
notice. It stands in for the design's paused notice, since the daemon holds no paused state, and it
goes away when another turn starts.
