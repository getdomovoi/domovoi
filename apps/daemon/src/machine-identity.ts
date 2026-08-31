import { randomBytes } from "node:crypto"
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises"
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

async function publishMachineIdentity(
  path: string,
  identity: MachineIdentity,
): Promise<MachineIdentity> {
  const temporaryPath = `${path}.${randomBytes(8).toString("hex")}.tmp`
  try {
    const handle = await open(temporaryPath, "wx", 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(identity, null, 2)}\n`, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(temporaryPath, path)
    } catch (error) {
      // Windows refuses to rename over a path another start still holds open.
      const published = await readMachineIdentity(path)
      if (published) return published
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error
      await rm(path, { force: true })
      await rename(temporaryPath, path)
    }
    return identity
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}

async function claimInitialization(lockPath: string): Promise<boolean> {
  try {
    await (await open(lockPath, "wx", 0o600)).close()
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
    throw error
  }
}

async function awaitPublishedIdentity(path: string): Promise<MachineIdentity | undefined> {
  for (let attempt = 0; attempt < identityReadAttempts; attempt += 1) {
    const identity = await readMachineIdentity(path)
    if (identity) return identity
    await delay(identityReadDelayMs)
  }
  return undefined
}

export async function loadOrCreateMachineIdentity(
  path: string,
  defaults: { label: string },
): Promise<MachineIdentity> {
  const directory = dirname(path)
  const lockPath = `${path}.lock`
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== "win32") await chmod(directory, 0o700)

  for (let takeover = 0; takeover < 2; takeover += 1) {
    const existing = await readMachineIdentity(path)
    if (existing) {
      if (process.platform !== "win32") await chmod(path, 0o600)
      return existing
    }

    if (await claimInitialization(lockPath)) {
      try {
        const published = await publishMachineIdentity(path, {
          id: `machine-${randomBytes(16).toString("hex")}`,
          label: normalizeMachineLabel(defaults.label),
        })
        if (process.platform !== "win32") await chmod(path, 0o600)
        return published
      } finally {
        await rm(lockPath, { force: true })
      }
    }

    // Another start is initializing; wait for its identity so one machine never
    // reports two identifiers.
    const settled = await awaitPublishedIdentity(path)
    if (settled) {
      if (process.platform !== "win32") await chmod(path, 0o600)
      return settled
    }

    // Nothing was published within the wait, so the claim belonged to a start
    // that died before publishing. Clear its lock and try once more.
    await rm(lockPath, { force: true })
  }

  throw new Error("Machine identity is malformed")
}
