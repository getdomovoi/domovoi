---
"@getdomovoi/ui": patch
---

Skills: trust and revoke are the only two decisions for a skill in a project. "Trust it for
<project>" enables the skill for the open project and then records a manual review of the same
content digest on this machine, through the two existing RPCs in sequence; the project grant goes
first, so a failure part-way leaves the narrower state. "Revoke" disables the skill for the project
only, and the machine review stays, since it also governs Build auto in other projects. The separate
"Mark reviewed on this machine" control is gone, and the detail pane says when and from which client
the project reviewed the skill.

Installing from a path: a refusal on any file still refuses the whole install, since the folder
digest is what was reviewed. The card now says the install cannot proceed and lists the typed
refusals, and the dialog says that installing does not enable the skill in any project.

Skills, Tools and the trust sheet name a skill's source and an agent in text only. No third-party
harness mark is drawn until the marks are vendored and their use is checked.
