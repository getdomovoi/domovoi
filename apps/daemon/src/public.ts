export {
  createProductionDaemon,
  type ProductionDaemonCredential,
  type ProductionDaemonEndpoint,
  type ProductionDaemonHandle,
  type ProductionDaemonOptions,
} from "./production-daemon.js"

export type { DaemonErrorEntry, DaemonErrorSink } from "./server.js"
export { verifyLocalFleetClientRoute } from "./local-client-route.js"
export { holdServiceHandoffFence, readLocalServiceHandoffRefusal, type ServiceHandoffFence } from "./local-service-handoff.js"
// The desktop main process calls this before anything else runs.
export { captureInheritedCredentials, type InheritedCredentialValues } from "./inherited-credentials.js"
// The desktop recognises the profile refusals by name, so their classes stay
// inside the daemon; it calls the check itself.
export { serviceProfileMismatch } from "./service/configuration.js"
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
  DaemonServiceHandoffError,
  DaemonServiceRuntimeMissingError,
  DaemonServiceUpdateError,
  installDaemonService,
  LaunchdJobNotDomovoiError,
  readDaemonServiceRuntimeCopy,
  readDaemonServiceRuntimeVersion,
  readDaemonServiceStatus,
  removeDaemonService,
  SystemdPathCharacterError,
  updateDaemonService,
  type DaemonServiceDependencies,
  type DaemonServiceRuntimeCopy,
  type DaemonServiceRuntimeReport,
  type DaemonServiceInstallResult,
  type DaemonServiceOptions,
  type DaemonServiceRemovalResult,
  type DaemonServiceRuntime,
  type DaemonServiceStagedRuntime,
  type DaemonServiceStatus,
  type DaemonServiceUpdateOptions,
  type DaemonServiceUpdateOutcome,
  type RuntimeFileState,
  WindowsTaskArgumentVariableError,
  WindowsTaskNotDomovoiError,
  WindowsTaskPathError,
  WindowsTaskPercentSignError,
} from "./service/desktop-service.js"
export {
  removeUnusedDaemonRuntimes,
  type DaemonRuntimeCleanupOptions,
  type DaemonRuntimeCleanupResult,
} from "./service/runtime-cleanup.js"
export {
  daemonRuntimeLayout,
  nodeRuntimeFileSystem,
  prepareDaemonRuntime,
  profileRuntimeDirectory,
  stageDaemonRuntime,
  type DaemonRuntimeStageInput,
  type PreparedDaemonRuntime,
  type RuntimeEntry,
  type RuntimeFileSystem,
} from "./service/runtime-stage.js"
