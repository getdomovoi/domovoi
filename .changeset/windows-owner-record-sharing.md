---
"@getdomovoi/daemon": patch
---

A Windows daemon no longer exits at startup when another process has its local owner record open.
Windows refuses to replace a file that another reader holds open, such as the desktop, a CLI status
check or an antivirus scan, and the daemon's `local-owner.json` publish failed with EPERM and an
uncaught error. Under the login service that counted as a crash, and enough of them exhausted
supervision. The replace now retries an EPERM, EACCES or EBUSY refusal on Windows for up to five
seconds, the same bound the Windows supervisor record uses, and blocks the daemon for at most that
long. A file still held after five seconds fails with an error that names the file and the sharing
refusal. Other platforms and other errors fail at once as before.
