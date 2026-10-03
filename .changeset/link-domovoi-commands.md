---
"@getdomovoi/ui": minor
"@getdomovoi/desktop": minor
---

Settings > Daemon on this machine gains Terminal commands: Link the commands puts `domovoid` and `domovoi` in `~/.local/bin` as links to the copies inside the app, and Remove the links, offered whenever either command is linked, takes them away again. Where linking is not offered (a linked or non-directory `~/.local/bin`, an app running from a disk image or a temporary copy, Windows), it says why, and it shows a refusal for any entry it did not make. Every command the desktop prints for this machine (the service commands, the profile recovery, the key commands, the pairing command and the refused-daemon screen) names what runs: the short name when linked and `~/.local/bin` is on the app's PATH, the link's path otherwise, and the launcher inside the app by its full path when nothing is linked. An app running from a disk image, a temporary copy or an AppImage names no launcher, because that path will not exist once the app quits: commands print as written, and the row points to Install for the login service.
