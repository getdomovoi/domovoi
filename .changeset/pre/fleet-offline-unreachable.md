---
"@getdomovoi/daemon": patch
"@getdomovoi/protocol": patch
---

Report fleet machines as unreachable when failed connection attempts outlast the existing offline heartbeat bound. Keep brief failures reconnecting and restore healthy status after authenticated contact resumes.
