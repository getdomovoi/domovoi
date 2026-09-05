import filesystem from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { setTimeout as delay } from "node:timers/promises"

const path = process.argv[2]
if (!path) throw new Error("Missing isolated credential path")
const open = filesystem.open
filesystem.open = async (file, flags, ...rest) => {
  const handle = await open(file, flags, ...rest)
  if (flags === "wx" && String(file).startsWith(path)) {
    handle.writeFile = async () => {
      // The parent kills this actual process while the new file is empty.
      // Never print the generated secret or hold indefinitely if the parent fails.
      process.stdout.write("DOMOVOI_CREDENTIAL_WRITE_HELD\n")
      await delay(15_000)
      throw new Error("Credential interruption fixture exceeded its hold budget")
    }
  }
  return handle
}
syncBuiltinESMExports()
const { loadOrCreateDaemonToken } = await import("../src/credentials.ts")
await loadOrCreateDaemonToken(path)
