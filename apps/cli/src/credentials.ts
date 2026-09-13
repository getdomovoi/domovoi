import { rename } from "node:fs/promises"

import {
  nativeKeyring as sharedNativeKeyring, openCredentialBackend,
  type CredentialBackend, type Keyring,
} from "@getdomovoi/credential-store"
import { z } from "zod"

export { CredentialStoreError, type Keyring } from "@getdomovoi/credential-store"

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

export type CredentialStore = {
  readonly where: "keyring" | "file"
  load(endpoint: string): Promise<PairedDaemon | undefined>
  save(record: PairedDaemon): Promise<void>
  forget(endpoint: string): Promise<void>
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
  return backend.where === "keyring" ? keyringStore(backend.keyring) : fileStore(backend)
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

function fileStore(backend: Extract<CredentialBackend, { where: "file" }>): CredentialStore {
  const read = async () => {
    const text = await backend.read()
    return text === undefined ? { version: 1 as const, daemons: [] } : fileSchema.parse(JSON.parse(text))
  }
  const write = (contents: z.infer<typeof fileSchema>) => backend.write(`${JSON.stringify(contents, null, 2)}\n`)
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
// Linux box with no unlocked libsecret, most containers). The shared keyring
// probes once with a read and keeps the error: a locked keychain and a
// missing one need different advice.
export function nativeKeyring(): Keyring {
  return sharedNativeKeyring({ service: keyringService, probeAccount: "domovoi-cli-probe" })
}
