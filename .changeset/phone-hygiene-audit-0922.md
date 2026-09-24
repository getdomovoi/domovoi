---
"@getdomovoi/mobile": patch
---

The phone's RPC client is typed against the protocol: each call's params are checked when the app compiles, and each answer is read by its method's result schema and the JSON-RPC response schema before anything waiting on it runs. An answer that fails is reported as an out of date app instead of being used. The phone no longer sends a client field on approval.resolve, which that method does not take. Thread rows that did not change are not drawn or parsed again on a keystroke. The app now builds under the repository's strict TypeScript settings. The review screen no surface reached is removed.
