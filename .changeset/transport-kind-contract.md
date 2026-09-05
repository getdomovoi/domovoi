---
"@getdomovoi/protocol": patch
"@getdomovoi/daemon": patch
---

Validate direct transport kinds as a discriminated contract before selecting an endpoint.
Local, WSL and SSH routes require loopback; LAN and tailnet require non-loopback TLS endpoints.
Only SSH accepts a configuration flag, and it must be explicit. Reserved relay records cannot
be enabled through the legacy availability flag. Endpoint bounds and credential-protection
rules are shared with enrollment. A loopback advertise host is now classified as local.

Previously accepted contradictory cached descriptors fail closed. Ship this change with the
damaged fleet-row quarantine so those records remain visible and recoverable through fresh
enrollment rather than being silently relabelled.
