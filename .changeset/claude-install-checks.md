---
"@getdomovoi/daemon": patch
"@getdomovoi/protocol": patch
"@getdomovoi/ui": patch
---

Claude Code sessions now refuse, with a message that says what to install, the two installs the
Claude Agent SDK cannot run. On Windows the SDK starts `claude` without a shell, so the npm `claude`
shim and `claude.cmd` failed with a raw spawn error; the daemon now takes only the native
`claude.exe` and otherwise names the shim it found. And nothing tied the installed Claude Code to
the SDK, which passes the flags of the version it was built against (`claudeCodeVersion` 2.1.263
for SDK 0.3.263); an older `claude` is now refused with "Update Claude Code to 2.1.263 or newer".

Provider readiness carries the same text in a new optional `problem` field. The desktop and web
clients show it in Settings and first run, label the provider "Cannot start", and keep it out of
the launcher.
