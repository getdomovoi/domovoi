export { WorkspaceShell, type WorkspaceShellProps } from "./workspace-shell"
export {
  type DesktopDirectoryResult,
  type DesktopExternalEditor,
  type DesktopOpenExternalRequest,
  type DesktopWindowBridge,
} from "./desktop-platform"
export {
  dialTransport,
  isLoopbackEndpoint,
  TransportDialError,
  type DialedTransport,
} from "./transport-dial"
export { StartupError } from "./startup-error"
export { DaemonCredentialPrompt } from "./daemon-credential-prompt"
export { ProviderSettings, type ProviderSecretStatus } from "./provider-settings"
