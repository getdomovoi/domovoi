---
"@getdomovoi/daemon": patch
"@getdomovoi/protocol": patch
---

The protocol package exports `notificationMethods`, the schema of the params of every notification
the daemon sends, with the `NotificationMethod` and `NotificationParams` types. The daemon now sends
a notification only if its payload parses against that schema and carries no field the schema does
not describe. A refused notification is reported and not sent. A workspace resync that cannot be
built closes the slow client, which reconnects, instead of sending an unchecked snapshot. The
daemon's RPC writer sends a notification only as a frame built from `notificationMethods`, and a
response only as a frame whose serialized envelope is a JSON-RPC 2.0 response, whose result parses
against its method's result schema, whose error data is one of the protocol's declared error data
kinds, and which carries no field those schemas do not describe. A result that fails the check is
reported and the request gets an internal error instead.
