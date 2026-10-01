---
"@getdomovoi/daemon": patch
---

The daemon gains a loader for the web app bundle. It reads a bundle into memory once and refuses the whole bundle, with a typed reason, when the manifest is missing, malformed or for another protocol minor, a path is not plain or names a daemon route, an extension is outside the table, a file is a link, a FIFO or another non-regular file, the root overlaps the profile directory, a file or directory is writable by group or others, a size or digest differs, or two listed paths open one file. Nothing calls the loader yet, so the daemon serves nothing new.
