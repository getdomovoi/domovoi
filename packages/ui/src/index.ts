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
export { claimMachine, MachineClaimError, type ClaimConnection } from "./claim-machine"
export { PairMachineDialog } from "./pair-machine-dialog"
export { pairMachine, MachinePairingError, type PairedMachine, type PairMachineRequest } from "./pair-machine"
export { openClaimConnection } from "./claim-socket"
export { connectMachineClient, type ConnectedMachineClient } from "./machine-client"
export {
  dialTransport,
  isLoopbackEndpoint,
  TransportDialError,
  type DialedTransport,
} from "./transport-dial"
export { StartupError } from "./startup-error"
export { DaemonCredentialPrompt } from "./daemon-credential-prompt"
export { AppearanceSettings, ProviderSettings, type ProviderSecretStatus } from "./provider-settings"
