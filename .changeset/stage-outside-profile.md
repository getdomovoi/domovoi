---
"@getdomovoi/desktop": patch
---

The desktop copies the shipped runtime into a private staging directory outside every profile (the system temporary directory when it is on the runtime directory's volume, otherwise the directory that holds the profile directory) and moves it into the profile with one rename when the service call publishes it. A path swapped during the copy can no longer redirect it into another profile.
