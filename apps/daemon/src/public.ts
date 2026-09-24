export {
  createProductionDaemon,
  type ProductionDaemonCredential,
  type ProductionDaemonEndpoint,
  type ProductionDaemonHandle,
  type ProductionDaemonOptions,
} from "./production-daemon.js"

export type { DaemonErrorEntry, DaemonErrorSink } from "./server.js"
export { verifyLocalFleetClientRoute } from "./local-client-route.js"
export { readLocalServiceHandoffRefusal } from "./local-service-handoff.js"
export { adoptRelayProfileSuccessor, prepareRelayProfileSuccessor, verifyRelayProfileSuccessor } from "./relay-provisioning.js"
export type { RelayProfileRecoveryOptions } from "./relay-provisioning.js"
export {
  acquireLocalDaemon,
  type AcquireLocalDaemonOptions,
  type LocalDaemonEndpoint,
  type LocalDaemonHandle,
  type LocalDaemonRefusalReason,
} from "./local-daemon.js"
export {
  DaemonServiceRuntimeMissingError,
  installDaemonService,
  readDaemonServiceStatus,
  removeDaemonService,
  type DaemonServiceDependencies,
  type DaemonServiceInstallResult,
  type DaemonServiceOptions,
  type DaemonServiceRemovalResult,
  type DaemonServiceRuntime,
  type DaemonServiceStatus,
  type RuntimeFileState,
} from "./service/desktop-service.js"
