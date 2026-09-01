export { WorkspaceShell, type WorkspaceShellProps } from "./workspace-shell"
export {
  type DesktopDirectoryResult,
  type DesktopExternalEditor,
  type DesktopOpenExternalRequest,
  type DesktopWindowBridge,
} from "./desktop-platform"
export { claimMachine, MachineClaimError, type ClaimConnection } from "./claim-machine"
export { PairMachineDialog, type PairMachineRequest } from "./pair-machine-dialog"
export { connectMachineClient, type ConnectedMachineClient } from "./machine-client"
export {
  dialTransport,
  isLoopbackEndpoint,
  TransportDialError,
  type DialedTransport,
} from "./transport-dial"
export { StartupError } from "./startup-error"
export { DaemonCredentialPrompt } from "./daemon-credential-prompt"
export { ProviderSettings, type ProviderSecretStatus } from "./provider-settings"
