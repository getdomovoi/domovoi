import { randomBytes } from "node:crypto"
import { chmod, mkdir, open, readFile } from "node:fs/promises"
import { dirname } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

export type MachineIdentity = {
  id: string
  label: string
}

export const defaultMachineLabel = "domovoi-machine"

const machineIdPattern = /^machine-[0-9a-f]{32}$/
const maximumLabelLength = 128
const identityReadAttempts = 20
const identityReadDelayMs = 5

export function normalizeMachineLabel(label: string): string {
  const trimmed = label.trim().slice(0, maximumLabelLength).trim()
  return trimmed || defaultMachineLabel
}

function parseMachineIdentity(contents: string): MachineIdentity | undefined {
  if (!contents) return undefined
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

async function readMachineIdentity(path: string): Promise<MachineIdentity> {
  for (let attempt = 0; attempt < identityReadAttempts; attempt += 1) {
    const identity = parseMachineIdentity((await readFile(path, "utf8")).trim())
    if (identity) return identity
    await delay(identityReadDelayMs)
  }
  throw new Error("Machine identity is malformed")
}

export async function loadOrCreateMachineIdentity(
  path: string,
  defaults: { label: string },
): Promise<MachineIdentity> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== "win32") await chmod(directory, 0o700)

  try {
    const handle = await open(path, "wx", 0o600)
    try {
      const identity: MachineIdentity = {
        id: `machine-${randomBytes(16).toString("hex")}`,
        label: normalizeMachineLabel(defaults.label),
      }
      await handle.writeFile(`${JSON.stringify(identity, null, 2)}\n`, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }

  if (process.platform !== "win32") await chmod(path, 0o600)
  return readMachineIdentity(path)
}
