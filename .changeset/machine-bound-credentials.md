---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": minor
"@getdomovoi/ui": minor
---

Bind a paired credential to the machine that claims it. A machine no longer
states its own identity when it connects; identity comes from the credential it
presents, so a caller can no longer claim to be a machine it is not.

This changes the wire, and the shared protocol moves to 0.2.0 so peers that
speak the old one fail at the handshake instead of agreeing to talk and then
failing inside a call. Machines running an older build show as a version
mismatch until they are updated.

Credentials issued before this change could act as either a machine or a person,
which is the ambiguity being removed, so they are revoked when the daemon
migrates. Every existing pairing has to be made again. A device revoked this way
says so in the paired devices list, and any move to a machine whose credential
was retired refuses with a message asking for that machine to be paired again.
