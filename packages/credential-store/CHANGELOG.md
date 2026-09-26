# @getdomovoi/credential-store

## 0.1.0-alpha.0

### Minor Changes

- a5fde27: `publishFileDurably(staging, path)` renames a flushed staging file into place and flushes its directory, so the rename survives power loss on POSIX. The desktop's relay pin file publishes through it.
- ccc14a7: A keychain that does not answer is reported as unavailable, never as an absent credential. `nativeKeyring` wraps anything the native binding throws from a read, write or delete in `CredentialStoreUnavailableError`, with the binding's error as the cause and a message that says to unlock the store and that the pairing is unchanged. A null from the binding stays the only "no credential". The CLI passes that error through instead of printing "Not paired".

### Patch Changes

- 4aa3ef7: Update @napi-rs/keyring to 2.0.0. A locked or inaccessible keychain now throws from every read and write, and a delete returns false only when nothing was there; every caller already reports that throw as unavailable and never as an absent credential.
- 704c709: Share explicit keychain or private-file selection, descriptor checks and atomic credential publication.
