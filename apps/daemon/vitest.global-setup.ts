import { readdir } from "node:fs/promises"
import { userInfo } from "node:os"
import { join } from "node:path"

async function entries(profile: string): Promise<string[] | undefined> {
  try { return await readdir(profile) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

// This is a read-only backstop for paths derived from userInfo(), which ignores
// HOME. Compare top-level names only, without reading profile file contents.
export async function nativeProfileEntryGuard(home: string, requireAbsent = false) {
  const profile = join(home, ".domovoi")
  const before = await entries(profile)
  if (requireAbsent && before !== undefined) {
    throw new Error("The native Domovoi profile must be absent on CI before daemon tests")
  }
  const original = new Set(before)
  return async () => {
    const after = await entries(profile)
    if (before === undefined && after !== undefined) {
      throw new Error("Daemon tests created the native Domovoi profile")
    }
    if (after?.some((entry) => !original.has(entry))) {
      throw new Error("Daemon tests added entries to the native Domovoi profile")
    }
  }
}

export default function setup() {
  return nativeProfileEntryGuard(userInfo().homedir, Boolean(process.env.CI))
}
