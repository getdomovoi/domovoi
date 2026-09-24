---
"@getdomovoi/protocol": patch
"@getdomovoi/daemon": patch
---

The daemon reads the web app a pairing code can be opened in from `DOMOVOI_WEB_APP_URL`, or `webAppUrl` in the service configuration file. It must be an absolute `http` or `https` URL without credentials or a fragment, at most 2048 characters; the daemon refuses to start with anything else and does not echo the value. When it is set, `device.issueCode` returns it as `webAppUrl` beside `pairingAddress`; when it is unset, the result has no `webAppUrl`. The protocol validates the field with `webAppUrlSchema`.
