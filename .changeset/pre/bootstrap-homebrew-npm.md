---
"@getdomovoi/daemon": patch
---

Find npm when Node is installed through Homebrew. The bootstrap probed only two paths beside the Node executable, so a Cellar layout that links its npm launcher was told to install a supported Node distribution while a working npm 11 was present. It now follows that link to a real npm-cli.js, and refuses dangling links, shell wrappers and directories. It also resolves the extracted package directory before handing npm a prefix, because a symlinked staging path made npm treat the package as a separate linked root.
