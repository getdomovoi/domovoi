import { createHash } from "node:crypto"
import { resolve } from "node:path"

export type RendererTarget =
  | { kind: "file"; path: string }
  | { kind: "url"; url: string }

export function rendererTargetUrl(target: RendererTarget): string {
  return target.kind === "url" ? target.url : "domovoi-app://desktop/index.html"
}

type RendererFrame = {
  readonly url: string
}

type RendererWebContents = {
  readonly mainFrame: RendererFrame
}

export type RendererIpcEvent = {
  readonly sender: unknown
  readonly senderFrame: RendererFrame | null
}

function loopbackRendererUrl(value: string | undefined): URL | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    if (url.username || url.password) return null
    if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") return null
    return url
  } catch {
    return null
  }
}

export function resolveRendererTarget(options: {
  isPackaged: boolean
  rendererUrl: string | undefined
  bundledRendererPath: string
}): RendererTarget {
  if (!options.isPackaged) {
    const rendererUrl = loopbackRendererUrl(options.rendererUrl)
    if (rendererUrl) return { kind: "url", url: rendererUrl.href }
  }
  return { kind: "file", path: resolve(options.bundledRendererPath) }
}

// The daemon's default origin list names the packaged app and the web client's
// port. A development renderer is served by Vite on whatever port it took, so
// the desktop names that origin itself rather than widening a shipped default.
// An operator who set the list keeps it.
export function developmentDaemonEnvironment(
  environment: NodeJS.ProcessEnv,
  target: RendererTarget,
): NodeJS.ProcessEnv {
  if (target.kind !== "url" || environment.DOMOVOI_ALLOWED_ORIGINS !== undefined) return environment
  return { ...environment, DOMOVOI_ALLOWED_ORIGINS: new URL(target.url).origin }
}

export function isTrustedRendererFrameUrl(frameUrl: string, target: RendererTarget): boolean {
  try {
    const actual = new URL(frameUrl)
    const expected = new URL(rendererTargetUrl(target))
    return actual.protocol === expected.protocol
      && actual.host === expected.host
      && actual.pathname === expected.pathname
  } catch {
    return false
  }
}

const loopbackSources = "ws://127.0.0.1:* wss://127.0.0.1:* ws://localhost:* wss://localhost:*"

const loopbackIpv6 = /^\[(?:::1|::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4})\]$/iu

function parsedEndpoint(endpointUrl: string | undefined): URL | undefined {
  try {
    return endpointUrl === undefined ? undefined : new URL(endpointUrl)
  } catch {
    return undefined
  }
}

export function rendererEndpointUrl(endpointUrl: string): string {
  const url = parsedEndpoint(endpointUrl)
  if (!url || !loopbackIpv6.test(url.hostname)) return endpointUrl
  url.hostname = "localhost"
  return url.href
}

// Vite injects the react-refresh preamble as an inline script, so a development
// page cannot load under script-src 'self' alone. Hashing what the page actually
// carries keeps the policy exact: no 'unsafe-inline', and nothing pinned to a
// preamble text that the plugin is free to change.
const inlineScript = /<script(?![^>]*\ssrc[\s=])[^>]*>([\s\S]*?)<\/script>/giu

export function inlineScriptHashes(html: string): readonly string[] {
  return [...html.matchAll(inlineScript)]
    .map((match) => match[1] ?? "")
    .filter((body) => body.length > 0)
    .map((body) => `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`)
}

export function rendererContentSecurityPolicy(
  endpointUrl: string | undefined,
  scriptHashes: readonly string[] = [],
): string {
  const url = parsedEndpoint(endpointUrl && rendererEndpointUrl(endpointUrl))
  const endpoint = url && (url.protocol === "ws:" || url.protocol === "wss:") && !url.hostname.startsWith("[")
    ? ` ${url.protocol}//${url.host}`
    : ""
  const preview = endpoint.replace(/^ ws:/u, " http:").replace(/^ wss:/u, " https:")
  return `default-src 'self'; connect-src 'self' ${loopbackSources}${endpoint}; `
    + `frame-src 'self'${preview}; `
    + "style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; "
    + `script-src ${["'self'", ...scriptHashes].join(" ")}`
}

export function isAuthorizedRendererEvent(
  event: RendererIpcEvent,
  expectedWebContents: RendererWebContents,
  target: RendererTarget,
): boolean {
  return event.sender === expectedWebContents
    && event.senderFrame === expectedWebContents.mainFrame
    && isTrustedRendererFrameUrl(event.senderFrame.url, target)
}
