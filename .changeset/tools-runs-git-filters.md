---
"@getdomovoi/ui": patch
---

The Tools tab lists the repository's Git filter settings a grant covers in a panel of their own, beside the agent entries that run when a session starts: "N reviewed Git filter settings are covered by this repository's trust", with every setting as the review showed it. It says Git may run the filters they define during checkout, staging and other Git operations on matching files, and that not every setting listed runs, since an empty process turns clean and smudge off, process is used before clean and smudge, and a later value replaces an earlier one. Git LFS settings are labelled as one agent's program, arguments or selection rather than as commands. While such settings are covered, the tab says no agent entry runs when a session starts instead of saying nothing from the repository can run.
