import { readFile } from "node:fs/promises"
import { extname, resolve, sep } from "node:path"

import type { FleetOriginAdmission } from "./fleet-origin.js"
import { rendererContentSecurityPolicy } from "./renderer-security.js"

export const rendererAppOrigin = "domovoi-app://desktop"
export const fleetWorkerPath = "/fleet-socket.js"

const contentTypes: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".ico": "image/x-icon",
}

export function fleetWorkerPolicy(url: string, origins: FleetOriginAdmission): string {
  return origins.consume(new URL(url).searchParams.get("route") ?? "")
}

// file:// ignores response CSP in Chromium. Serve only the bundled renderer
// directory over a standard, secure app scheme, with no bypassCSP privilege.
export async function rendererResource(input: {
  url: string; method: string; directory: string; endpoint: string | undefined; origins: FleetOriginAdmission
}): Promise<Response> {
  const url = new URL(input.url)
  if (url.origin !== rendererAppOrigin && `${url.protocol}//${url.host}` !== rendererAppOrigin) return new Response(null, { status: 403 })
  if (input.method !== "GET") return new Response(null, { status: 405 })
  let pathname: string
  try { pathname = decodeURIComponent(url.pathname) } catch { return new Response(null, { status: 400 }) }
  if (/[\\\0]/u.test(pathname)) return new Response(null, { status: 403 })
  const root = resolve(input.directory)
  const path = resolve(root, `.${pathname}`)
  if (!path.startsWith(`${root}${sep}`)) return new Response(null, { status: 403 })
  const mime = contentTypes[extname(path)]
  if (!mime) return new Response(null, { status: 403 })
  const policy = pathname === fleetWorkerPath ? fleetWorkerPolicy(input.url, input.origins)
    : rendererContentSecurityPolicy(input.endpoint)
  try {
    return new Response(await readFile(path), { headers: {
      "Content-Type": mime, "Content-Security-Policy": policy, "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    } })
  } catch { return new Response(null, { status: 404 }) }
}
