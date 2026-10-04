---
"@getdomovoi/daemon": patch
---

Preserve non-default daemon settings when installing systemd, launchd, and Windows logon services. Each launch reads the same validated non-secret configuration, including TLS paths, listener settings, allowed origins, and identity paths. Installation refuses an environment-only bearer instead of silently changing credentials; use a private credential file before installing. Service manager operations share a bounded deadline.
