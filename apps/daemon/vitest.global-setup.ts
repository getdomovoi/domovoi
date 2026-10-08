import { readdir, stat } from "node:fs/promises"
import { userInfo } from "node:os"
import { join } from "node:path"

async function entries(profile: string): Promise<string[] | undefined> {
  try { return await readdir(profile) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

async function leaseMetadata(profile: string, names: string[]) {
  return new Map(await Promise.all(names.filter((name) => /\.sqlite(?:-journal)?$/.test(name)).map(async (name) => {
    const { ctimeNs, mtimeNs } = await stat(join(profile, name), { bigint: true })
    return [name, { ctimeNs, mtimeNs }] as const
  })))
}

// This is a read-only backstop for paths derived from userInfo(), which ignores
// HOME. Compare names and metadata without reading profile file contents.
export async function nativeProfileEntryGuard(home: string, requireAbsent = false) {
  const profile = join(home, ".domovoi")
  const before = await entries(profile)
  if (requireAbsent && before !== undefined) {
    throw new Error("The native Domovoi profile must be absent on CI before daemon tests")
  }
  const original = new Set(before)
  const directoryMtime = before === undefined ? undefined : (await stat(profile, { bigint: true })).mtimeNs
  const leases = await leaseMetadata(profile, before ?? [])
  return async () => {
    const after = await entries(profile)
    if (before === undefined && after !== undefined) {
      throw new Error("Daemon tests created the native Domovoi profile")
    }
    if (after?.some((entry) => !original.has(entry))) {
      throw new Error("Daemon tests added entries to the native Domovoi profile")
    }
    if (before !== undefined && (after === undefined || before.some((entry) => !after.includes(entry)))) {
      throw new Error("Daemon tests removed entries from the native Domovoi profile")
    }
    if (after === undefined) return
    if ((await stat(profile, { bigint: true })).mtimeNs !== directoryMtime) {
      throw new Error("Daemon tests changed the native Domovoi profile directory mtime")
    }
    const currentLeases = await leaseMetadata(profile, after)
    for (const [name, originalLease] of leases) {
      const current = currentLeases.get(name)
      if (current?.ctimeNs !== originalLease.ctimeNs || current.mtimeNs !== originalLease.mtimeNs) {
        throw new Error(`Daemon tests changed the native Domovoi profile lease metadata: ${name}`)
      }
    }
  }
}

export function runningInCi(environment: NodeJS.ProcessEnv): boolean {
  const flag = environment.CI
  return flag !== undefined && flag !== "" && flag !== "0" && flag.toLowerCase() !== "false"
}

export default function setup() {
  return nativeProfileEntryGuard(userInfo().homedir, runningInCi(process.env))
}
