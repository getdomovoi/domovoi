---
"@getdomovoi/desktop": minor
---

The desktop app's runtime now carries the `domovoi` CLI beside the daemon, each with a launcher in `daemon-runtime/bin` that runs it with the Node program the app ships. These are what the app links into `~/.local/bin`, and what a printed command names by full path where no link exists.
