---
"@getdomovoi/daemon": patch
---

Windows replaces more of its metadata files when another process has the old one open. Windows
refuses to replace a file that a reader holds open, such as the supervisor, a status check, the
desktop or an antivirus scan, and these replaces failed at once with EPERM, EACCES or EBUSY: a
workspace restore's owner record, the service configuration `service.json` written during install
or update, and the owner removal receipt. Each now retries that refusal on Windows for up to five
seconds, waiting 5 ms and doubling to 250 ms, the bound the local owner record already uses. The
service and removal writes still stop at their operation deadline. A file still held after five
seconds fails with an error that names the file and the sharing refusal. Other platforms and other
errors fail at once as before.
