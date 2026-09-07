---
"@getdomovoi/protocol": patch
"@getdomovoi/daemon": patch
"@getdomovoi/ui": patch
"@getdomovoi/desktop": patch
---

Add separate, kind-bound remote client grants and Fleet client admission. A machine pairing remains daemon-to-daemon authority, not permission for a desktop or browser to control the target.

Operators issue a separate client credential on the target with `domovoid pair --client desktop --label "My desktop"`, then choose Authorize this client in Fleet. Use, Terminal and inventory reads require the target identity and client receipt to verify. Desktop main verifies each enrolled route through the home daemon and grants only that exact socket origin. Update both daemons and the client before using these additive calls. The wire remains 0.5.0, existing pairings remain valid and no re-pair is required.

Client credentials stay only in app memory. Closing the app or removing local access does not revoke the remote grant; revoke the device in the target's Devices list. Remote Desktop preview frames remain unavailable until they have a separate verified path. This does not enable a hosted relay or expose the daemon's machine keychain to the client.

Desktop serves its bundle from an explicit app origin so response CSP is enforced. Existing development profiles may need appearance, layout and first-run preferences selected again because old file-origin browser storage is not migrated. The daemon profile and its canonical sessions are unchanged.

If `DOMOVOI_ALLOWED_ORIGINS` is explicitly configured, add the exact `domovoi-app://desktop` origin and restart that daemon. The default configuration already includes it; custom lists are not silently widened.
