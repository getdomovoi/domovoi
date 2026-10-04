---
"@getdomovoi/ui": patch
"@getdomovoi/web": patch
"@getdomovoi/desktop": patch
---

The Skills tab's "Inventories from your other machines" now draws one row per other machine, with its platform, architecture and daemon version and what its inventory says: how many skills it reported, unreachable, or no inventory returned. It used to draw one unnamed row for every skill on every machine, this one included. The per-skill comparison stays on the selected skill.
