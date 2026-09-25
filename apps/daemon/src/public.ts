export {
  createProductionDaemon,
  type ProductionDaemonCredential,
  type ProductionDaemonEndpoint,
  type ProductionDaemonHandle,
  type ProductionDaemonOptions,
} from "./production-daemon.js"

export type { DaemonErrorEntry, DaemonErrorSink } from "./server.js"
export { verifyLocalFleetClientRoute } from "./local-client-route.js"
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
  DaemonServiceUpdateError,
  installDaemonService,
  readDaemonServiceStatus,
  removeDaemonService,
  updateDaemonService,
  type DaemonServiceDependencies,
  type DaemonServiceInstallResult,
  type DaemonServiceOptions,
  type DaemonServiceRemovalResult,
  type DaemonServiceRuntime,
  type DaemonServiceStatus,
  type DaemonServiceUpdateOptions,
  type DaemonServiceUpdateOutcome,
  type RuntimeFileState,
  WindowsTaskNotDomovoiError,
  WindowsTaskPercentSignError,
} from "./service/desktop-service.js"
