// Native boundary only. Never load the operator's actual keychain during this
// test. A synchronous constructor hold models a locked or silent OS service.
import Module from "node:module"
import { appendFileSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isMainThread, Worker } from "node:worker_threads"

const load = Module._load
const entries = new Map()
const control = process.env.DOMOVOI_TEST_KEYRING_DIRECTORY
if (!control) throw new Error("Missing isolated keyring control directory")
const record = (kind, account) => appendFileSync(join(control, "events"), `${JSON.stringify({ kind, account, isMainThread })}\n`)
if (process.env.DOMOVOI_TEST_KEYRING_UNSTOPPABLE === "1") {
  // Model a native call that cannot acknowledge V8 termination yet. The
  // parent test has a kill deadline; the synthetic native hold is also finite.
  Worker.prototype.terminate = () => new Promise(() => {})
}

class Entry {
  constructor(service, account) {
    if (service !== "domovoi.machine-credential") throw new Error("Unexpected keychain service")
    record("construct", account)
    this.account = account
    if (!existsSync(join(control, "block"))) return
    writeFileSync(join(control, "entered"), JSON.stringify({ isMainThread }))
    writeFileSync(join(control, "native-stack"), new Error("Native fixture entered").stack)
    const until = performance.now() + (process.env.DOMOVOI_TEST_KEYRING_UNSTOPPABLE === "1" ? 60_000 : 20_000)
    const sleeper = new Int32Array(new SharedArrayBuffer(4))
    while (existsSync(join(control, "block"))) {
      if (performance.now() >= until) throw new Error("Keyring test hold exceeded its deadline")
      Atomics.wait(sleeper, 0, 0, Math.min(20, until - performance.now()))
    }
  }
  getPassword() { record("get", this.account); return entries.get(this.account) ?? null }
  setPassword(secret) { record("set", this.account); entries.set(this.account, secret) }
  deletePassword() { record("delete", this.account); return entries.delete(this.account) }
}

Module._load = function (specifier, ...args) {
  return specifier === "@napi-rs/keyring" ? { Entry } : load.call(this, specifier, ...args)
}
