---
"@getdomovoi/credential-store": minor
---

`publishFileDurably` now retries a Windows sharing refusal on its rename. Windows refuses to replace
a file another process holds open, and the rename failed at once with EPERM, EACCES or EBUSY; it now
retries those codes on Windows for up to five seconds, waiting 5 ms and doubling to 250 ms, then
fails with a `FileSharingError` that names the file. Callers include update state, the tool path
record, runtime staging and cleanup, the desktop relay pins and tailnet reach records, and isolated
checkout `HEAD` files. The same retry is exported as `replaceFile` (asynchronous wait) and
`replaceFileSync` (blocking wait), with `FileSharingError` and `windowsSharingBudgetMs`. Other
platforms and other errors fail at once as before.
