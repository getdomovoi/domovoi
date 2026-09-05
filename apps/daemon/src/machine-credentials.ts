import { createHash } from "node:crypto"
import { createRequire } from "node:module"

import { credentialSchema, machineIdSchema } from "@getdomovoi/protocol"

const keychainService = "domovoi.machine-credential"
// The index lives in the keychain beside the credentials, so the daemon still
// knows which machines it holds after a restart.
const indexAccount = "domovoi.machine-credential.index"

export interface MachineKeyring {
  get(account: string): string | undefined
  set(account: string, secret: string): void
  delete(account: string): unknown
  list?(): string[]
}

export class MachineCredentialUnavailableError extends Error {
  constructor() {
    super("OS keychain is unavailable on this machine")
    this.name = "MachineCredentialUnavailableError"
  }
}

export interface MachineCredentials {
  save(machineId: string, credential: string): void
  forMachine(machineId: string): string | undefined
  forget(machineId: string): void
  machines(): string[]
}

// Cross-store journals keep only this commitment, never keychain bytes. Binding
// the identity as well as the domain prevents a digest from moving to a new row.
export function machineCredentialDigest(machineId: string, credential: string): string {
  requireMachineId(machineId)
  if (!credentialSchema.safeParse(credential).success) throw new Error("Machine credential is malformed")
  return `sha256:${createHash("sha256")
    .update("domovoi:machine-credential:v1\0").update(machineId).update("\0").update(credential).digest("hex")}`
}

// A credential for another machine is a secret like any provider key, so it
// lives in the OS keychain rather than in the state database, and no error
// carries its bytes.
export class MachineCredentialStore implements MachineCredentials {
  readonly #keyring: MachineKeyring

  constructor(keyring: MachineKeyring = new NativeMachineKeyring()) {
    this.#keyring = keyring
  }

  #index(): string[] {
    let stored: string | undefined
    try {
      stored = this.#keyring.get(indexAccount)
    } catch {
      throw new MachineCredentialUnavailableError()
    }
    if (!stored) return []
    try {
      const parsed: unknown = JSON.parse(stored)
      if (!Array.isArray(parsed)) return []
      // Anything but a machine identity means the index is not ours to trust,
      // so it is discarded rather than partly believed.
      const identities = parsed.filter(
        (id): id is string => typeof id === "string" && machineIdSchema.safeParse(id).success,
      )
      return identities.length === parsed.length ? identities : []
    } catch {
      return []
    }
  }

  #writeIndex(machineIds: string[]): void {
    try {
      this.#keyring.set(indexAccount, JSON.stringify([...new Set(machineIds)].sort()))
    } catch {
      throw new MachineCredentialUnavailableError()
    }
  }

  save(machineId: string, credential: string): void {
    requireMachineId(machineId)
    if (!credentialSchema.safeParse(credential).success) throw new Error("Machine credential is malformed")
    try {
      this.#keyring.set(machineId, credential)
    } catch {
      throw new MachineCredentialUnavailableError()
    }
    this.#writeIndex([...this.#index(), machineId])
  }

  forMachine(machineId: string): string | undefined {
    requireMachineId(machineId)
    try {
      return this.#keyring.get(machineId)
    } catch {
      throw new MachineCredentialUnavailableError()
    }
  }

  forget(machineId: string): void {
    requireMachineId(machineId)
    try {
      this.#keyring.delete(machineId)
    } catch {
      throw new MachineCredentialUnavailableError()
    }
    this.#writeIndex(this.#index().filter((held) => held !== machineId))
  }

  machines(): string[] {
    return this.#index()
  }
}

function requireMachineId(machineId: string): void {
  if (!machineIdSchema.safeParse(machineId).success) throw new Error("Machine identity is malformed")
}

type KeyringEntry = {
  getPassword(): string | null
  setPassword(secret: string): void
  deletePassword(): unknown
}

type KeyringBinding = {
  Entry: new (service: string, account: string) => KeyringEntry
}

const require = createRequire(import.meta.url)

export class NativeMachineKeyring implements MachineKeyring {
  #binding: KeyringBinding | undefined
  readonly #checkpoint: () => void

  constructor(checkpoint: () => void = () => {}) { this.#checkpoint = checkpoint }

  #entry(account: string): KeyringEntry {
    this.#checkpoint()
    const entry = new (this.#requireBinding().Entry)(keychainService, account)
    this.#checkpoint()
    return entry
  }

  get(account: string): string | undefined {
    const value = this.#entry(account).getPassword() ?? undefined
    this.#checkpoint()
    return value
  }

  set(account: string, secret: string): void {
    this.#entry(account).setPassword(secret)
    this.#checkpoint()
  }

  delete(account: string): void {
    this.#entry(account).deletePassword()
    this.#checkpoint()
  }

  #requireBinding(): KeyringBinding {
    this.#binding ??= require("@napi-rs/keyring") as KeyringBinding
    return this.#binding
  }
}
