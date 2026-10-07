---
"@getdomovoi/protocol": patch
"@getdomovoi/daemon": patch
"@getdomovoi/ui": patch
---

Preserve absent provider effort defaults and start those models with unset effort. Claude offers Model's own first when effort is supported, omits the initial effort override, and clears an existing override when unset is selected. Normalize legacy effort values to unset when a model reports neither levels nor a default, so stored sessions can restart and change runtime.
