import { mkdir, open, rename, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"

import {
  CredentialStoreError, nativeKeyring as sharedNativeKeyring, openCredentialBackend,
  type CredentialBackend, type Keyring,
} from "@getdomovoi/credential-store"
import { relayClientPinSchema } from "@getdomovoi/protocol"
import { z } from "zod"

export { CredentialStoreError, type Keyring } from "@getdomovoi/credential-store"

// One record per paired daemon. The endpoint is the key: a CLI on one machine
// may be paired with several daemons, and each pairing is its own device.
export const pairedDaemonSchema = z.object({
  endpoint: z.string().url(),
  machineId: z.string().regex(/^machine-[0-9a-f]{32}$/),
  deviceId: z.string().min(1),
  token: z.string().min(1),
  // The daemon's relay identity as this client last trusted it. Public data,
  // but its integrity is what admission rests on, so it lives with the bearer.
  relayPin: relayClientPinSchema.optional(),
}).strict()

export type PairedDaemon = z.infer<typeof pairedDaemonSchema>

const fileSchema = z.object({
  version: z.literal(1),
  daemons: z.array(pairedDaemonSchema),
}).strict()

export type CredentialStore = {
  readonly where: "keyring" | "file"
  load(endpoint: string): Promise<PairedDaemon | undefined>
  save(record: PairedDaemon): Promise<void>
  forget(endpoint: string): Promise<void>
  // Read-modify-write of one pairing with no other writer in between. Every
  // writer on a backing store, from any handle in any process, takes the same
  // exclusive lock file: beside the credential file, or under $HOME for the
  // keyring, which offers no compare of its own. Returning undefined from
  // update leaves the record untouched.
  update(endpoint: string, change: (current: PairedDaemon | undefined) => PairedDaemon | undefined): Promise<boolean>
}

export const keyringService = "domovoi-cli"

const fileWarning = (path: string) =>
  `Credentials for this daemon are kept in ${path}, not in an OS keychain. The file is mode 0600 and holds a bearer that grants session sends, approvals and terminals. Anyone who can read it can act as you on that daemon.`

const unavailable = (cause?: Error) =>
  (cause
    ? `The OS keychain did not answer (${cause.message}), so this daemon's credential cannot be kept there. Unlock it and run this again, or`
    : "No OS keychain is available here, so there is nowhere safe to keep this daemon's credential.")
  + " Pass --credential-file <path> to keep it in a file you own (mode 0600), and treat that file as the bearer it holds."

// Keychain when present. Otherwise only an explicit --credential-file, with
// the mode enforced and the warning printed, and never a silent dotfile: a CLI
// that quietly writes a bearer under $HOME is the thing the product's
// argument about credentials cannot survive. The policy itself lives in
// @getdomovoi/credential-store, shared with the daemon, so there is one
// answer to where a credential lives when there is no keychain.
export async function openCredentialStore(input: {
  keyring: Keyring
  home: string
  credentialFile?: string
  warn: (text: string) => void
  publish?: typeof rename
}): Promise<CredentialStore> {
  const backend = await openCredentialBackend({
    keyring: input.keyring,
    ...(input.credentialFile === undefined ? {} : { credentialFile: input.credentialFile }),
    warn: input.warn,
    fileWarning,
    unavailable,
    ...(input.publish === undefined ? {} : { publish: input.publish }),
  })
  // Every writer, from every handle and every process, takes the same lock.
  // The keyring has no file to lock beside, so its lock lives under $HOME
  // like the profile does; it guards ordering only and holds no secret.
  return backend.where === "keyring"
    ? keyringStore(backend.keyring, join(input.home, ".domovoi", "cli-credentials.lock"))
    : fileStore(backend)
}

function keyringStore(keyring: Keyring, lockPath: string): CredentialStore {
  const load = async (endpoint: string) => {
    const raw = await keyring.get(endpoint)
    if (raw === undefined) return undefined
    return pairedDaemonSchema.parse(JSON.parse(raw))
  }
  const locked = <T>(operation: () => Promise<T>) => withFileLock(lockPath, operation)
  return {
    where: "keyring",
    load,
    save(record) {
      return locked(async () => { await keyring.set(record.endpoint, JSON.stringify(pairedDaemonSchema.parse(record))) })
    },
    forget(endpoint) {
      return locked(async () => { await keyring.delete(endpoint) })
    },
    update(endpoint, change) {
      return locked(async () => {
        const next = change(await load(endpoint))
        if (next === undefined) return false
        await keyring.set(endpoint, JSON.stringify(pairedDaemonSchema.parse(next)))
        return true
      })
    },
  }
}

// An exclusive lock file beside the credential file. Creation is atomic
// (O_EXCL), so two processes cannot both hold it; a holder that died leaves
// a file that a later caller treats as stale after the wait limit and says so.
async function withFileLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + 10_000
  for (;;) {
    let handle
    try {
      handle = await open(lockPath, "wx", 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      if (Date.now() > deadline) throw new CredentialStoreError(`${lockPath} is held by another process, or was left behind by one that died. Remove it if no other domovoi is running.`)
      await new Promise((resolve) => setTimeout(resolve, 20))
      continue
    }
    try {
      await handle.close()
      return await operation()
    } finally {
      await unlink(lockPath).catch(() => undefined)
    }
  }
}

function fileStore(backend: Extract<CredentialBackend, { where: "file" }>): CredentialStore {
  const read = async () => {
    const text = await backend.read()
    return text === undefined ? { version: 1 as const, daemons: [] } : fileSchema.parse(JSON.parse(text))
  }
  const write = (contents: z.infer<typeof fileSchema>) => backend.write(`${JSON.stringify(contents, null, 2)}\n`)
  const locked = <T>(operation: () => Promise<T>) => withFileLock(`${backend.path}.lock`, operation)
  return {
    where: "file",
    async load(endpoint) {
      return (await read()).daemons.find((daemon) => daemon.endpoint === endpoint)
    },
    update(endpoint, change) {
      return locked(async () => {
        const contents = await read()
        const next = change(contents.daemons.find((daemon) => daemon.endpoint === endpoint))
        if (next === undefined) return false
        contents.daemons = [...contents.daemons.filter((daemon) => daemon.endpoint !== endpoint), pairedDaemonSchema.parse(next)]
        await write(contents)
        return true
      })
    },
    save(record) {
      return locked(async () => {
        const contents = await read()
        contents.daemons = [...contents.daemons.filter((daemon) => daemon.endpoint !== record.endpoint), pairedDaemonSchema.parse(record)]
        await write(contents)
      })
    },
    forget(endpoint) {
      return locked(async () => {
        const contents = await read()
        contents.daemons = contents.daemons.filter((daemon) => daemon.endpoint !== endpoint)
        await write(contents)
      })
    },
  }
}

// @napi-rs/keyring throws at first use where no backend exists (a headless
// Linux box with no unlocked libsecret, most containers). The shared keyring
// probes once with a read and keeps the error: a locked keychain and a
// missing one need different advice.
export function nativeKeyring(): Keyring {
  return sharedNativeKeyring({ service: keyringService, probeAccount: "domovoi-cli-probe" })
}
