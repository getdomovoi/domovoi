---
"@getdomovoi/daemon": patch
---

The service calls name and compare the caller's and the saved service's profile by the path rules of the platform the service is for, not the host's: a macOS or Linux service's default profile shows with `/` on any host, and Windows profiles compare without regard to case.
