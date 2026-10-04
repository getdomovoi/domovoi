---
"@getdomovoi/daemon": patch
"@getdomovoi/desktop": patch
---

When the only staging place on the profile's volume fails the check that no
other account can change it, the app's refusal says so instead of saying the
profile is on a different volume. It names the directory and the check: group
or others can write it, another account owns it, a macOS access control entry
lets another account change it, or who can change it could not be confirmed.
On Windows, where access rules are not read, it says the directory could not be
confirmed inside the user profile. It lists any directories made before the
refusal. Every other staging refusal keeps the different-volume sentence.
