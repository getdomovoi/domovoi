import type { AsyncMachineCredentials } from "./machine-credential-worker.js"
import { machineCredentialDigest, type MachineCredentials, type MachineCredentialStore } from "./machine-credentials.js"
import type { OperationDeadline } from "./operation-deadline.js"

// Test-only adapter for synchronous in-memory stores. Production must use the
// worker even when native construction, not just a method, contacts the OS.
export function asyncTestCredentials(store: MachineCredentials & Partial<Pick<MachineCredentialStore, "repairIndex" | "forgetIfMatching">>): AsyncMachineCredentials {
  const call = async <T>(deadline: OperationDeadline, run: () => T): Promise<T> => {
    deadline.throwIfExpired()
    const result = run()
    deadline.throwIfExpired()
    return result
  }
  return {
    save: (id, value, deadline) => call(deadline, () => store.save(id, value)),
    forMachine: (id, deadline) => call(deadline, () => store.forMachine(id)),
    forget: (id, deadline) => call(deadline, () => store.forget(id)),
    machines: (deadline) => call(deadline, () => store.machines()),
    close: async () => {},
    repairIndex: (id, digest, deadline) => call(deadline, () => {
      if (store.repairIndex) return store.repairIndex(id, digest)
      const held = store.forMachine(id)
      if (!held || machineCredentialDigest(id, held) !== digest) return false
      store.save(id, held)
      return store.machines().includes(id)
    }),
    forgetIfMatching: (id, digest, deadline) => call(deadline, () => {
      if (store.forgetIfMatching) return store.forgetIfMatching(id, digest)
      const held = store.forMachine(id)
      if (held !== undefined && machineCredentialDigest(id, held) !== digest) return false
      store.forget(id)
      return store.forMachine(id) === undefined && !store.machines().includes(id)
    }),
  }
}
