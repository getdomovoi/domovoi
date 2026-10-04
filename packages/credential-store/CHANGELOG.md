# @getdomovoi/credential-store

## 0.1.0-alpha.0

### Minor Changes

- a5fde27: `publishFileDurably(staging, path)` renames a flushed staging file into place and flushes its directory, so the rename survives power loss on POSIX. The desktop's relay pin file publishes through it.
- ccc14a7: A keychain that does not answer is reported as unavailable, never as an absent credential. `nativeKeyring` wraps anything the native binding throws from a read, write or delete in `CredentialStoreUnavailableError`, with the binding's error as the cause and a message that says to unlock the store and that the pairing is unchanged. A null from the binding stays the only "no credential". The CLI passes that error through instead of printing "Not paired".
- cdf92bc: `publishFileDurably` takes an optional third argument, a callback it runs once the rename is done and before the directory is flushed. A caller that owned the staging file by its name learns that it no longer does, even when the flush then fails. Callers that pass two arguments behave as before.

### Patch Changes

- 9a015e9: Update production dependencies. The daemon moves to Claude Agent SDK 0.3.281, Anthropic SDK 0.128.0,
  Agent Client Protocol SDK 1.5.0, Kilo SDK 7.7.9, OpenCode SDK 1.18.32, MCP SDK 1.30.1 and yaml
  2.9.1. Claude Agent SDK 0.3.281 is built against Claude Code 2.1.281, so the daemon now refuses an
  older `claude` with "Update Claude Code to 2.1.281 or newer". The floor was 2.1.263. The keyring
  binding moves to 2.1.0, zod to 4.6.5 and vite to 8.3.0. The shared ui and the web and desktop
  clients move to Lucide 1.47.0 and tailwind-merge 3.7.0, and stay on React 19.2.8 and
  react-resizable-panels 4.12.4: the newer two would put startup JavaScript over its budget. The
  phone takes Expo 57.0.24 and stays on the React, safe-area and SVG versions that SDK bundles.
- 4aa3ef7: Update @napi-rs/keyring to 2.0.0. A locked or inaccessible keychain now throws from every read and write, and a delete returns false only when nothing was there; every caller already reports that throw as unavailable and never as an absent credential.
- 704c709: Share explicit keychain or private-file selection, descriptor checks and atomic credential publication.
