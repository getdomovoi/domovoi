export { WorkspaceShell, type WorkspaceShellProps } from "./workspace-shell"
export {
  type DesktopDirectoryResult,
  type DesktopExternalEditor,
  type DesktopOpenExternalRequest,
  type DesktopWindowBridge,
  type WorkspaceWindowDecoration,
} from "./desktop-platform"
export { applyStoredAppearanceTheme } from "./workspace-persistence"
export { isWorkspaceTheme, type WorkspaceTheme } from "./appearance"
export { PairMachineDialog } from "./pair-machine-dialog"
export { pairMachine, MachinePairingError, enrollRefusalMessage, type PairedMachine, type PairMachineRequest } from "./pair-machine"
export { Deadline, DeadlineExceededError } from "./deadline"
export {
  DomovoiConnectTimeoutError,
  DomovoiRpcTimeoutError,
  type DomovoiClientBudgets,
  type DomovoiRequestOptions,
} from "./client"
export { connectMachineClient, type ConnectedMachineClient } from "./machine-client"
export {
  dialTransport,
  TransportDialTimeoutError,
  isLoopbackEndpoint,
  TransportDialError,
  type DialedTransport,
} from "./transport-dial"
export { StartupError } from "./startup-error"
export { WorkspaceErrorBoundary } from "./error-boundary"
export { DaemonCredentialPrompt } from "./daemon-credential-prompt"
export { AppearanceSettings, ProviderSettings, type ProviderSecretStatus } from "./provider-settings"
