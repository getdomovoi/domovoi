import { randomBytes } from "node:crypto"
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { dirname } from "node:path"

export type MachineIdentity = {
  id: string
  label: string
}

export const defaultMachineLabel = "domovoi-machine"

const machineIdPattern = /^machine-[0-9a-f]{32}$/
const maximumLabelLength = 128

export function normalizeMachineLabel(label: string): string {
  const trimmed = label.trim().slice(0, maximumLabelLength).trim()
  return trimmed || defaultMachineLabel
}

function parseMachineIdentity(contents: string): MachineIdentity {
  let value: unknown
  try {
    value = JSON.parse(contents)
  } catch {
    throw new Error("Machine identity is malformed")
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("Machine identity is malformed")
  }
  const { id, label } = value as { id?: unknown; label?: unknown }
  if (typeof id !== "string" || !machineIdPattern.test(id)) {
    throw new Error("Machine identity is malformed")
  }
  if (
    typeof label !== "string"
    || label.trim() === ""
    || label.length > maximumLabelLength
  ) {
    throw new Error("Machine identity is malformed")
  }
  return { id, label }
}

async function readMachineIdentity(path: string): Promise<MachineIdentity | undefined> {
  let contents: string
  try {
    contents = (await readFile(path, "utf8")).trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  // An empty file is an initialization that was interrupted before its content
  // was published, not a corrupted identity, so it is safe to replace.
  if (!contents) return undefined
  return parseMachineIdentity(contents)
}

async function publishMachineIdentity(path: string, identity: MachineIdentity): Promise<void> {
  const temporaryPath = `${path}.${randomBytes(8).toString("hex")}.tmp`
  try {
    const handle = await open(temporaryPath, "wx", 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(identity, null, 2)}\n`, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}

export async function loadOrCreateMachineIdentity(
  path: string,
  defaults: { label: string },
): Promise<MachineIdentity> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== "win32") await chmod(directory, 0o700)

  const existing = await readMachineIdentity(path)
  if (existing) {
    if (process.platform !== "win32") await chmod(path, 0o600)
    return existing
  }

  await publishMachineIdentity(path, {
    id: `machine-${randomBytes(16).toString("hex")}`,
    label: normalizeMachineLabel(defaults.label),
  })

  // Concurrent starts each publish a candidate; the identity left by the final
  // rename is the one every start returns.
  const settled = await readMachineIdentity(path)
  if (!settled) throw new Error("Machine identity is malformed")
  if (process.platform !== "win32") await chmod(path, 0o600)
  return settled
}
