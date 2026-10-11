---
"@getdomovoi/protocol": patch
"@getdomovoi/daemon": patch
---

Include optional daemon time in fleet snapshots, notifications, and mutation replies so clients can measure heartbeat ages against the daemon clock. Keep protocol version 0.8.0 and accept snapshots without the timestamp.
