---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": patch
"@getdomovoi/ui": patch
"@getdomovoi/mobile": patch
---

A sent message now shows what it carried. The daemon records each attachment on the user turn as metadata: an image's type, dimensions and size, a text file's name and size, a worktree file's path. It never records image bytes or text content. Desktop, browser, phone and tablet draw one chip per attachment under the message. A sent image is a chip, not a thumbnail, because no client and not the daemon keeps its bytes after the provider has them.
