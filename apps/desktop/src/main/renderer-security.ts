import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

export type RendererTarget =
  | { kind: "file"; path: string }
  | { kind: "url"; url: string }

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

export function isTrustedRendererFrameUrl(frameUrl: string, target: RendererTarget): boolean {
  try {
    const actual = new URL(frameUrl)
    const expected = target.kind === "url"
      ? new URL(target.url)
      : new URL(pathToFileURL(resolve(target.path)).href)
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

export function rendererContentSecurityPolicy(endpointUrl: string | undefined): string {
  const url = parsedEndpoint(endpointUrl && rendererEndpointUrl(endpointUrl))
  const endpoint = url && (url.protocol === "ws:" || url.protocol === "wss:") && !url.hostname.startsWith("[")
    ? ` ${url.protocol}//${url.host}`
    : ""
  return `default-src 'self'; connect-src 'self' ${loopbackSources}${endpoint}; `
    + "style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; script-src 'self'"
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
