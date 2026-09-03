import { randomBytes } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import { chmod, copyFile, link, mkdir, open, readFile, rm, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { machineIdSchema } from "@getdomovoi/protocol"

export type MachineIdentity = {
  id: string
  label: string
}

export const defaultMachineLabel = "domovoi-machine"

const maximumLabelLength = 128
const identityPollDelayMs = 5
const publicationReadAttempts = 100
export const defaultLockStalenessMs = 5_000
const unsupportedHardLinkCodes = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV"])

class MalformedMachineIdentityError extends Error {
  constructor() {
    super("Machine identity is malformed")
    this.name = "MalformedMachineIdentityError"
  }
}

export function normalizeMachineLabel(label: string): string {
  const trimmed = label.trim().slice(0, maximumLabelLength).trim()
  return trimmed || defaultMachineLabel
}

function parseMachineIdentity(contents: string): MachineIdentity {
  let value: unknown
  try {
    value = JSON.parse(contents)
  } catch {
    throw new MalformedMachineIdentityError()
  }
  if (typeof value !== "object" || value === null) {
    throw new MalformedMachineIdentityError()
  }
  const { id, label } = value as { id?: unknown; label?: unknown }
  if (typeof id !== "string" || !machineIdSchema.safeParse(id).success) {
    throw new MalformedMachineIdentityError()
  }
  if (
    typeof label !== "string"
    || label.trim() === ""
    || label.length > maximumLabelLength
  ) {
    throw new MalformedMachineIdentityError()
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
  // An empty file is an interrupted initialization. It has to remain distinct
  // from absence: deleting it automatically would let an overlapping publisher
  // remove a complete identity that appeared after this read.
  if (!contents) return undefined
  return parseMachineIdentity(contents)
}

export async function publishMachineIdentity(
  path: string,
  identity: MachineIdentity,
  hardLink: typeof link = link,
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
    return await publishCompletedIdentity(temporaryPath, path, identity, hardLink)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

async function publishCompletedIdentity(
  temporaryPath: string,
  path: string,
  identity: MachineIdentity,
  hardLink: typeof link,
): Promise<MachineIdentity> {
  try {
    // A hard link publishes the already-synced bytes without replacing an
    // identity another start won first. Every overlapping publisher either
    // creates this name or adopts the one that already owns it.
    await hardLink(temporaryPath, path)
    return identity
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "EEXIST") return await adoptPublishedIdentity(path)
    if (!code || !unsupportedHardLinkCodes.has(code)) {
      throw publicationError(path, code, error)
    }
  }

  try {
    // Exclusive copy keeps the same no-clobber rule on filesystems that do not
    // support hard links. A loser may briefly observe an incomplete copy, so
    // adoption polls for the complete identity below.
    await copyFile(temporaryPath, path, fsConstants.COPYFILE_EXCL)
    return identity
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "EEXIST") return await adoptPublishedIdentity(path)
    throw publicationError(path, code, error)
  }
}

async function adoptPublishedIdentity(path: string): Promise<MachineIdentity> {
  for (let attempt = 0; attempt < publicationReadAttempts; attempt += 1) {
    try {
      const identity = await readMachineIdentity(path)
      if (identity) return identity
    } catch (error) {
      if (!(error instanceof MalformedMachineIdentityError)) throw error
    }
    await delay(identityPollDelayMs)
  }
  throw new Error(
    `Machine identity at ${path} exists without a complete identity. Remove it explicitly before restarting Domovoi.`,
  )
}

function publicationError(path: string, code: string | undefined, cause: unknown): Error {
  return new Error(
    `Machine identity filesystem cannot publish without replacing an existing identity at ${path}${code ? ` (${code})` : ""}`,
    { cause },
  )
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

async function lockAgeMs(lockPath: string): Promise<number | undefined> {
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

// Waits as long as the claiming start looks alive. A fixed poll budget would
// hand the identity to a second start whenever publishing ran slowly.
async function awaitPublishedIdentity(
  path: string,
  lockPath: string,
  stalenessMs: number,
): Promise<MachineIdentity | undefined> {
  for (;;) {
    const identity = await readMachineIdentity(path)
    if (identity) return identity
    const age = await lockAgeMs(lockPath)
    if (age === undefined || age > stalenessMs) return undefined
    await delay(identityPollDelayMs)
  }
}

export async function loadOrCreateMachineIdentity(
  path: string,
  defaults: { label: string; lockStalenessMs?: number },
): Promise<MachineIdentity> {
  const directory = dirname(path)
  const lockPath = `${path}.lock`
  const stalenessMs = defaults.lockStalenessMs ?? defaultLockStalenessMs
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
        await publishMachineIdentity(path, {
          id: `machine-${randomBytes(16).toString("hex")}`,
          label: normalizeMachineLabel(defaults.label),
        })
        // Adopt whatever is persisted: a start that took this lock over may have
        // published first, and one machine keeps one identity.
        const persisted = await readMachineIdentity(path)
        if (persisted) {
          if (process.platform !== "win32") await chmod(path, 0o600)
          return persisted
        }
      } finally {
        await rm(lockPath, { force: true })
      }
    }

    // Another start is initializing; wait for its identity so one machine never
    // reports two identifiers.
    const settled = await awaitPublishedIdentity(path, lockPath, stalenessMs)
    if (settled) {
      if (process.platform !== "win32") await chmod(path, 0o600)
      return settled
    }

    // Nothing was published within the wait, so the claim belonged to a start
    // that died before publishing. Clear its lock and try once more.
    await rm(lockPath, { force: true })
  }

  throw new Error(`Machine identity initialization did not complete at ${path}`)
}
