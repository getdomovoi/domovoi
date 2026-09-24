---
---

Test-only: the mobile jest setup loads the React Native components the screens draw before the first test in each file, so a cold transform no longer runs inside a test's 5 s timeout. No package changes.
