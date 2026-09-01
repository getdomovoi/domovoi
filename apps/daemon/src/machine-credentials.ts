import { createRequire } from "node:module"

const machineIdPattern = /^machine-[0-9a-f]{32}$/
const credentialPattern = /^[A-Za-z0-9_-]{43}$/
const keychainService = "domovoi.machine-credential"

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

// A credential for another machine is a secret like any provider key, so it
// lives in the OS keychain rather than in the state database, and no error
// carries its bytes.
export class MachineCredentialStore {
  readonly #keyring: MachineKeyring
  readonly #held = new Set<string>()

  constructor(keyring: MachineKeyring = new NativeMachineKeyring()) {
    this.#keyring = keyring
  }

  save(machineId: string, credential: string): void {
    requireMachineId(machineId)
    if (!credentialPattern.test(credential)) throw new Error("Machine credential is malformed")
    try {
      this.#keyring.set(machineId, credential)
    } catch {
      throw new MachineCredentialUnavailableError()
    }
    this.#held.add(machineId)
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
    this.#held.delete(machineId)
  }

  machines(): string[] {
    return [...this.#held].sort()
  }
}

function requireMachineId(machineId: string): void {
  if (!machineIdPattern.test(machineId)) throw new Error("Machine identity is malformed")
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

  get(account: string): string | undefined {
    return new (this.#requireBinding().Entry)(keychainService, account).getPassword() ?? undefined
  }

  set(account: string, secret: string): void {
    new (this.#requireBinding().Entry)(keychainService, account).setPassword(secret)
  }

  delete(account: string): void {
    new (this.#requireBinding().Entry)(keychainService, account).deletePassword()
  }

  #requireBinding(): KeyringBinding {
    this.#binding ??= require("@napi-rs/keyring") as KeyringBinding
    return this.#binding
  }
}
