// Native boundary only. Never load the operator's actual keychain during this
// test. A synchronous constructor hold models a locked or silent OS service.
import Module from "node:module"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isMainThread } from "node:worker_threads"

const load = Module._load
const entries = new Map()
const control = process.env.DOMOVOI_TEST_KEYRING_DIRECTORY
if (!control) throw new Error("Missing isolated keyring control directory")

class Entry {
  constructor(service, account) {
    if (service !== "domovoi.machine-credential") throw new Error("Unexpected keychain service")
    this.account = account
    if (!existsSync(join(control, "block"))) return
    writeFileSync(join(control, "entered"), JSON.stringify({ isMainThread }))
    const until = performance.now() + 20_000
    const sleeper = new Int32Array(new SharedArrayBuffer(4))
    while (existsSync(join(control, "block"))) {
      if (performance.now() >= until) throw new Error("Keyring test hold exceeded its deadline")
      Atomics.wait(sleeper, 0, 0, Math.min(20, until - performance.now()))
    }
  }
  getPassword() { return entries.get(this.account) ?? null }
  setPassword(secret) { entries.set(this.account, secret) }
  deletePassword() { return entries.delete(this.account) }
}

Module._load = function (specifier, ...args) {
  return specifier === "@napi-rs/keyring" ? { Entry } : load.call(this, specifier, ...args)
}
