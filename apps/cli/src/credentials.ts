import { constants } from "node:fs"
import { chmod, mkdir, open, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import { z } from "zod"

// One record per paired daemon. The endpoint is the key: a CLI on one machine
// may be paired with several daemons, and each pairing is its own device.
export const pairedDaemonSchema = z.object({
  endpoint: z.string().url(),
  machineId: z.string().regex(/^machine-[0-9a-f]{32}$/),
  deviceId: z.string().min(1),
  token: z.string().min(1),
}).strict()

export type PairedDaemon = z.infer<typeof pairedDaemonSchema>

const fileSchema = z.object({
  version: z.literal(1),
  daemons: z.array(pairedDaemonSchema),
}).strict()

export type Keyring = {
  available(): Promise<boolean>
  // Why available() said no, when the backend exists but did not answer: a
  // locked keychain is not an absent one, and the fix for each is different.
  cause?(): Error | undefined
  get(account: string): Promise<string | undefined>
  set(account: string, secret: string): Promise<void>
  delete(account: string): Promise<void>
}

export class CredentialStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CredentialStoreError"
  }
}

export type CredentialStore = {
  readonly where: "keyring" | "file"
  load(endpoint: string): Promise<PairedDaemon | undefined>
  save(record: PairedDaemon): Promise<void>
  forget(endpoint: string): Promise<void>
}

export const keyringService = "domovoi-cli"

const fileWarning = (path: string) =>
  `Credentials for this daemon are kept in ${path}, not in an OS keychain. The file is mode 0600 and holds a bearer that grants session sends, approvals and terminals. Anyone who can read it can act as you on that daemon.`

// Keychain when present. Otherwise only an explicit --credential-file, with
// the mode enforced and the warning printed, and never a silent dotfile: a CLI
// that quietly writes a bearer under $HOME is the thing the product's
// argument about credentials cannot survive.
export async function openCredentialStore(input: {
  keyring: Keyring
  home: string
  credentialFile?: string
  warn: (text: string) => void
  publish?: (staging: string, path: string) => Promise<void>
}): Promise<CredentialStore> {
  if (input.credentialFile !== undefined) {
    const path = input.credentialFile
    await checkedFile(path, "check")
    input.warn(fileWarning(path))
    return fileStore(path, input.publish ?? rename)
  }
  if (await input.keyring.available()) return keyringStore(input.keyring)
  const cause = input.keyring.cause?.()
  throw new CredentialStoreError(
    (cause
      ? `The OS keychain did not answer (${cause.message}), so this daemon's credential cannot be kept there. Unlock it and run this again, or`
      : "No OS keychain is available here, so there is nowhere safe to keep this daemon's credential.")
    + " Pass --credential-file <path> to keep it in a file you own (mode 0600), and treat that file as the bearer it holds.",
  )
}

// The mode check and the read are one operation on one descriptor: open the
// file without following links, then judge and read the thing that was
// opened. A stat followed by a path read judges one file and reads whatever
// the path names by then.
async function checkedFile(path: string, mode: "check" | "read"): Promise<string | undefined> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return undefined
    if (code === "ELOOP" || code === "EMLINK") throw new CredentialStoreError(`${path} is a symlink. A credential file must be a regular file you own.`)
    throw error
  }
  try {
    const status = await handle.stat()
    if (!status.isFile()) throw new CredentialStoreError(`${path} is not a regular file.`)
    if (process.platform !== "win32" && (status.mode & 0o077) !== 0) {
      throw new CredentialStoreError(`${path} is readable by other users. Set it to mode 0600 before using it as a credential file.`)
    }
    return mode === "read" ? await handle.readFile("utf8") : undefined
  } finally {
    await handle.close()
  }
}

function keyringStore(keyring: Keyring): CredentialStore {
  return {
    where: "keyring",
    async load(endpoint) {
      const raw = await keyring.get(endpoint)
      if (raw === undefined) return undefined
      return pairedDaemonSchema.parse(JSON.parse(raw))
    },
    async save(record) {
      await keyring.set(record.endpoint, JSON.stringify(pairedDaemonSchema.parse(record)))
    },
    async forget(endpoint) {
      await keyring.delete(endpoint)
    },
  }
}

function fileStore(path: string, publish: (staging: string, path: string) => Promise<void>): CredentialStore {
  const read = async () => {
    const text = await checkedFile(path, "read")
    return text === undefined ? { version: 1 as const, daemons: [] } : fileSchema.parse(JSON.parse(text))
  }
  // Write beside the target and publish by rename, so a reader never sees a
  // half-written file. A failed publication removes the staging file first:
  // it holds the bearer, and "nothing was kept" has to be true.
  const write = async (contents: z.infer<typeof fileSchema>) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const staging = `${path}.${process.pid}.tmp`
    await writeFile(staging, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600, flag: "wx" })
    await chmod(staging, 0o600)
    try {
      await publish(staging, path)
    } catch (error) {
      await rm(staging, { force: true }).catch((cleanup: unknown) => {
        throw new CredentialStoreError(`${error instanceof Error ? error.message : String(error)}; and the staging file ${staging} could not be removed (${cleanup instanceof Error ? cleanup.message : String(cleanup)}). It holds the bearer. Delete it.`)
      })
      throw error
    }
  }
  return {
    where: "file",
    async load(endpoint) {
      return (await read()).daemons.find((daemon) => daemon.endpoint === endpoint)
    },
    async save(record) {
      const contents = await read()
      contents.daemons = [...contents.daemons.filter((daemon) => daemon.endpoint !== record.endpoint), pairedDaemonSchema.parse(record)]
      await write(contents)
    },
    async forget(endpoint) {
      const contents = await read()
      contents.daemons = contents.daemons.filter((daemon) => daemon.endpoint !== endpoint)
      await write(contents)
    },
  }
}

// @napi-rs/keyring throws at first use where no backend exists (a headless
// Linux box with no unlocked libsecret, most containers). Probe once with a
// read, which touches the backend without writing anything, and keep the
// error: a locked keychain and a missing one need different advice.
export function nativeKeyring(): Keyring {
  let module: Promise<typeof import("@napi-rs/keyring")> | undefined
  let cause: Error | undefined
  const load = () => (module ??= import("@napi-rs/keyring"))
  const entry = async (account: string) => new (await load()).Entry(keyringService, account)
  return {
    async available() {
      try {
        await (await entry("domovoi-cli-probe")).getPassword()
        return true
      } catch (error) {
        cause = error instanceof Error ? error : new Error(String(error))
        return false
      }
    },
    cause: () => cause,
    async get(account) {
      return (await entry(account)).getPassword() ?? undefined
    },
    async set(account, secret) {
      ;(await entry(account)).setPassword(secret)
    },
    async delete(account) {
      ;(await entry(account)).deletePassword()
    },
  }
}
