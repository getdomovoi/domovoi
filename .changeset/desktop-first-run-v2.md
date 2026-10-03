---
"@getdomovoi/ui": minor
"@getdomovoi/desktop": minor
---

Desktop first-run setup follows the v2 onboarding design. It starts at "Keep Domovoi running after you quit", which installs the login service through the same desktop bridge as Settings, with Not now to skip it, and says what failed and what still works when the install fails. The permission-mode step is gone; new sessions start in Build manual. Agents show as one card each: a CLI that needs signing in offers its own sign-in command to copy, and a missing CLI gets install guidance, never an installer. "One machine is enough for now" ends setup even when no agent is ready, and setup that was completed or skipped does not open again on the next launch; Settings > First-run setup opens it again.
