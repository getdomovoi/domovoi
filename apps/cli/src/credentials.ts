import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
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
}): Promise<CredentialStore> {
  if (input.credentialFile !== undefined) {
    const path = input.credentialFile
    await ensureFileMode(path)
    input.warn(fileWarning(path))
    return fileStore(path)
  }
  if (await input.keyring.available()) return keyringStore(input.keyring)
  throw new CredentialStoreError(
    "No OS keychain is available here, so there is nowhere safe to keep this daemon's credential."
    + " Pass --credential-file <path> to keep it in a file you own (mode 0600), and treat that file as the bearer it holds.",
  )
}

async function ensureFileMode(path: string): Promise<void> {
  let existing
  try {
    existing = await stat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  if (process.platform !== "win32" && (existing.mode & 0o077) !== 0) {
    throw new CredentialStoreError(`${path} is readable by other users. Set it to mode 0600 before using it as a credential file.`)
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

function fileStore(path: string): CredentialStore {
  const read = async () => {
    try {
      return fileSchema.parse(JSON.parse(await readFile(path, "utf8")))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1 as const, daemons: [] }
      throw error
    }
  }
  const write = async (contents: z.infer<typeof fileSchema>) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const staging = `${path}.${process.pid}.tmp`
    await writeFile(staging, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600, flag: "wx" })
    await chmod(staging, 0o600)
    await rename(staging, path)
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
// read, which touches the backend without writing anything.
export function nativeKeyring(): Keyring {
  let module: Promise<typeof import("@napi-rs/keyring")> | undefined
  const load = () => (module ??= import("@napi-rs/keyring"))
  const entry = async (account: string) => new (await load()).Entry(keyringService, account)
  return {
    async available() {
      try {
        await (await entry("domovoi-cli-probe")).getPassword()
        return true
      } catch {
        return false
      }
    },
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
