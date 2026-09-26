---
"@getdomovoi/daemon": minor
---

The daemon persists its trusted update metadata versions under the profile lease, read through a strict schema and published durably, and stages a verified update target through the bootstrap installer, which now ships inside the daemon package as `dist/bootstrap-install.js` so an installed runtime can stage without the repository.
