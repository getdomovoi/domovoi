// Keep the published internal path inert. Its artifact remains for package
// compatibility, but raw construction belongs only to source-level daemon
// tests and the production factory.
export type { DaemonErrorEntry, DaemonErrorSink } from "./server.js"
