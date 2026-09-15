export {
  createProductionDaemon,
  type ProductionDaemonCredential,
  type ProductionDaemonEndpoint,
  type ProductionDaemonHandle,
  type ProductionDaemonOptions,
} from "./production-daemon.js"

export type { DaemonErrorEntry, DaemonErrorSink } from "./server.js"
export { verifyLocalFleetClientRoute } from "./local-client-route.js"
export {
  canonicalUpdateJson,
  fetchUpdateMetadata,
  selectUpdateTarget,
  UpdateVerificationError,
  verifyUpdateMetadata,
  verifyUpdateRoot,
} from "./update-verification.js"
export { adoptRelayProfileSuccessor, prepareRelayProfileSuccessor, verifyRelayProfileSuccessor } from "./relay-provisioning.js"
export type { RelayProfileRecoveryOptions } from "./relay-provisioning.js"
export {
  acquireLocalDaemon,
  type AcquireLocalDaemonOptions,
  type LocalDaemonEndpoint,
  type LocalDaemonHandle,
  type LocalDaemonRefusalReason,
} from "./local-daemon.js"
