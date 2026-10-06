import type { IncomingMessage, RequestListener, ServerResponse } from "node:http"

import type { WebAppBundleLoad } from "./web-app-bundle.js"

export type WebAppHttpOptions = {
  bundle: WebAppBundleLoad
  // Supplied after listen, using the actual port. These are Host authorities,
  // not browser origins; this handler makes no WebSocket admission decisions.
  authorities: ReadonlySet<string>
  scheme: "http" | "https"
}

const stateCsp = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"

function canonicalAuthority(authority: string | undefined, scheme: WebAppHttpOptions["scheme"]): string | undefined {
  // Accept only a hostname or bracketed IP with an optional numeric port.
  // URL alone also accepts credentials, paths and characters unsafe in CSP.
  if (authority === undefined || !/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])(?::[0-9]+)?$/i.test(authority)) return undefined
  try {
    // URL removes the default port for this scheme (80 or 443), folds DNS
    // names and canonicalizes IPv6. Never use the HTTP-only server helper.
    return new URL(`${scheme}://${authority}`).host
  } catch {
    return undefined
  }
}

function appCsp(authority: string | undefined, scheme: WebAppHttpOptions["scheme"]): string {
  const socketSource = authority === undefined ? "" : ` ${scheme === "https" ? "wss" : "ws"}://${authority}`
  return "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    + "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'" + socketSource
    + "; frame-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; "
    + "form-action 'none'; frame-ancestors 'none'"
}

function securityHeaders(response: ServerResponse, csp: string): void {
  response.setHeader("content-security-policy", csp)
  response.setHeader("x-content-type-options", "nosniff")
  response.setHeader("referrer-policy", "no-referrer")
  response.setHeader("x-frame-options", "DENY")
  response.setHeader("cross-origin-opener-policy", "same-origin")
  response.setHeader("cross-origin-resource-policy", "same-origin")
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()")
}

function requestPath(target: string | undefined): string | undefined {
  if (target === undefined || !target.startsWith("/") || target.startsWith("//")) return undefined
  // Drop queries before any validation and never retain or report their contents.
  const path = target.split("?", 1)[0]!
  for (const character of path) {
    if (character <= " " || character === "\u007f") return undefined
  }
  if (/[\\#]/.test(path) || /%2f/i.test(path)) return undefined
  // Reject dot segments before URL normalizes them to a valid entry such as /.
  if (/(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(path)) return undefined
  try {
    const decoded = decodeURIComponent(new URL(path, "http://domovoi.local").pathname)
    if (decoded.includes("\0") || decoded.includes("\\") || /%2f/i.test(decoded)) return undefined
    return decoded
  } catch {
    return undefined
  }
}

function send(request: IncomingMessage, response: ServerResponse, status: number, contentType: string, body: string | Buffer): void {
  response.statusCode = status
  response.setHeader("content-type", contentType)
  response.setHeader("content-length", Buffer.byteLength(body))
  response.end(request.method === "HEAD" ? undefined : body)
}

function statePage(bundle: Exclude<WebAppBundleLoad, { state: "loaded" }>): string {
  let copy: string
  switch (bundle.state) {
    case "absent":
      copy = "No web app is installed for this Domovoi daemon. The machine's owner can install one; the daemon's startup output says where it looks."
      break
    case "invalid":
      copy = "The web app installed here failed its checks, so it is not served. The daemon's log names the file."
      break
    case "incompatible": {
      // Only public major.minor numbers enter the HTML, never diagnostic fields.
      const minor = (version: string) => /^\d+\.\d+/.exec(version)?.[0] ?? "unknown"
      copy = `The web app installed here is for protocol ${minor(bundle.bundleProtocolVersion)}, and this daemon speaks ${minor(bundle.daemonProtocolVersion)}. Install the web app from the same release as the daemon.`
      break
    }
  }
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1"><title>Domovoi</title>'
    + '</head><body><main><h1>Domovoi</h1><p>' + copy + '</p></main></body></html>'
}

function matchesEtag(value: string | undefined, etag: string): boolean {
  if (value === undefined) return false
  // GET and HEAD use weak comparison, including validator lists and wildcard.
  return value.split(",").some((part) => {
    const candidate = part.trim()
    return candidate === "*" || candidate.replace(/^W\//, "") === etag
  })
}

// Handles the app and its 404s after the caller has dispatched daemon routes.
// All file bytes and metadata come from the checked, loaded map. No disk I/O,
// logging, compression, Range handling or SPA fallback happens per request.
export function createWebAppHttpHandler({ bundle, authorities, scheme }: WebAppHttpOptions): RequestListener {
  const allowed = new Set<string>()
  for (const authority of authorities) {
    const canonical = canonicalAuthority(authority, scheme)
    if (canonical !== undefined) allowed.add(canonical)
  }
  const page = bundle.state === "loaded" ? undefined : statePage(bundle)

  return (request, response) => {
    const candidate = canonicalAuthority(request.headers.host, scheme)
    const authority = candidate !== undefined && allowed.has(candidate) ? candidate : undefined
    securityHeaders(response, appCsp(authority, scheme))
    response.setHeader("cache-control", "no-store")
    const notFound = () => send(request, response, 404, "application/json", '{"error":"not_found"}')
    if (authority === undefined) {
      notFound()
      return
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("allow", "GET, HEAD")
      send(request, response, 405, "application/json", '{"error":"method_not_allowed"}')
      return
    }
    const path = requestPath(request.url)
    if (path === undefined || path === "/domovoi-web.json") {
      notFound()
      return
    }
    if (bundle.state !== "loaded") {
      if (path !== "/") {
        notFound()
        return
      }
      response.setHeader("content-security-policy", stateCsp)
      send(request, response, 503, "text/html; charset=utf-8", page!)
      return
    }
    const file = bundle.files.get(path === "/" ? "/index.html" : path)
    if (file === undefined) {
      notFound()
      return
    }
    response.setHeader("cache-control", file.cacheClass === "entry" ? "no-cache" : "private, max-age=31536000, immutable")
    response.setHeader("etag", file.etag)
    if (file.cacheClass === "entry" && matchesEtag(request.headers["if-none-match"], file.etag)) {
      response.statusCode = 304
      response.end()
      return
    }
    send(request, response, 200, file.contentType, file.bytes)
  }
}
