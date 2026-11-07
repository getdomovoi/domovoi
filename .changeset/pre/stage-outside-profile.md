---
"@getdomovoi/desktop": patch
---

The desktop copies the shipped runtime into a private staging directory outside every profile and moves it into the profile with one rename when the service call publishes it, so a path swapped during the copy cannot redirect it into another profile.
