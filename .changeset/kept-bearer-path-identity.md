---
"@getdomovoi/daemon": patch
---

Pin a kept inherited bearer to its profile directory by device, inode and canonical path. A
directory at another path that reports the same device and inode, as a new directory can when a
filesystem such as ext4 gives it the inode number of one just deleted, no longer receives the
bearer kept for the deleted profile. The directory's birth time is not part of the identity:
where statx is unavailable, the reported birth time is the change time, which moves whenever a
file is added to the directory.

A profile directory that exists but whose canonical path cannot then be read, for any reason
including ENOENT, now receives no kept bearer. It used to be read as a directory that did not
exist yet and could match a bearer pinned by path.
