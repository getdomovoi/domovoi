---
"@getdomovoi/desktop": patch
---

When the system temporary directory is on another volume than the profile's runtime directory, the desktop stages the runtime under `<app data>/runtime-staging`, only when that is a real directory on the runtime's volume, outside the profile and outside any repository. Otherwise it refuses, writing nothing: `The profile directory <path> is on a different volume from this app's temporary and data directories, so the runtime could not be copied without writing inside a profile. Nothing was changed.`
