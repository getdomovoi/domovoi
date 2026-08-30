import { parse, serialize, type DefaultTreeAdapterTypes } from "parse5"

export const maximumPrintableArtifactBytes = 4 * 1_024 * 1_024
export const maximumPrintableArtifactNodes = 50_000
export const maximumPrintableArtifactDepth = 64

const removedElements = new Set([
  "script", "iframe", "object", "embed", "input", "button", "select", "textarea",
  "link", "base", "meta", "canvas", "audio", "video", "source", "track", "picture",
  "portal", "frame", "frameset", "applet", "foreignobject", "animate", "set",
  "title",
])
const unwrappedElements = new Set(["form"])
const networkAttributes = new Set([
  "src", "srcset", "poster", "background", "data", "action", "formaction", "ping",
  "xlink:href",
])

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}

function safeLink(value: string): string | undefined {
  if (value.startsWith("#") && /^#[A-Za-z][A-Za-z0-9_.:-]{0,255}$/.test(value)) return value
  if (/^https?:\/\/[^\s]+$/i.test(value) || /^mailto:[^\s@]+@[^\s@]+$/i.test(value)) return value
  return undefined
}

function sanitizeCss(value: string): string {
  return value
    .replace(/@import\s+(?:url\s*\([^)]*\)|[^;]*);?/gi, "")
    .replace(/url\s*\([^)]*\)/gi, "none")
    .replace(/(?:expression|-moz-binding|behavior)\s*:[^;}]*[;}]/gi, "")
}

function sanitizeElement(element: DefaultTreeAdapterTypes.Element): void {
  const nextAttributes: typeof element.attrs = []
  let safeHref: string | undefined
  for (const attribute of element.attrs) {
    const name = attribute.name.toLowerCase()
    if (name.startsWith("on") || networkAttributes.has(name) || name === "autofocus" || name === "contenteditable") continue
    if (name === "href") {
      if (element.tagName === "a") safeHref = safeLink(attribute.value)
      continue
    }
    if (name === "style") {
      const value = sanitizeCss(attribute.value)
      if (value.trim()) nextAttributes.push({ ...attribute, value })
      continue
    }
    if (name === "target" || name === "rel") continue
    nextAttributes.push(attribute)
  }
  if (element.tagName === "a" && safeHref) {
    nextAttributes.push({ name: "href", value: safeHref })
    if (!safeHref.startsWith("#")) {
      nextAttributes.push({ name: "target", value: "_blank" })
      nextAttributes.push({ name: "rel", value: "noopener noreferrer" })
    }
  }
  element.attrs = nextAttributes
  if (element.tagName === "style") {
    for (const child of element.childNodes) {
      if ("value" in child && typeof child.value === "string") child.value = sanitizeCss(child.value)
    }
  }
}

function sanitizeChildren(parent: DefaultTreeAdapterTypes.ParentNode, depth: number, counter: { value: number }): void {
  if (depth > maximumPrintableArtifactDepth) throw new Error("Printable artifact exceeds depth limit")
  const children: DefaultTreeAdapterTypes.ChildNode[] = []
  for (const child of parent.childNodes) {
    counter.value += 1
    if (counter.value > maximumPrintableArtifactNodes) throw new Error("Printable artifact exceeds node limit")
    if ("tagName" in child) {
      if (removedElements.has(child.tagName)) continue
      sanitizeElement(child)
      sanitizeChildren(child, depth + 1, counter)
      if (unwrappedElements.has(child.tagName)) {
        for (const grandchild of child.childNodes) {
          grandchild.parentNode = parent
          children.push(grandchild)
        }
        continue
      }
      if ("content" in child) sanitizeChildren(child.content, depth + 1, counter)
    }
    child.parentNode = parent
    children.push(child)
  }
  parent.childNodes = children
}

const printCss = `
:root{color-scheme:light}*{box-sizing:border-box}html{background:#fff;color:#111;font:12pt/1.55 system-ui,sans-serif}body{max-width:920px;margin:0 auto;padding:20mm}pre,code{font-family:ui-monospace,SFMono-Regular,monospace}pre{white-space:pre-wrap;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse}th,td{border:1px solid #bbb;padding:6px;vertical-align:top}img,svg{max-width:100%;height:auto}.domovoi-safe-note{border:1px solid #bbb;padding:8px 10px;margin:0 0 16px;font-size:10pt;color:#444}@page{margin:16mm}@media print{html,body{print-color-adjust:exact;-webkit-print-color-adjust:exact}body{max-width:none;margin:0;padding:0}pre,table,blockquote,figure{break-inside:avoid}a{overflow-wrap:anywhere}.domovoi-safe-note{break-after:avoid}}
`.trim()

export function sanitizePrintableArtifact(content: string, title: string): string {
  if (Buffer.byteLength(content, "utf8") > maximumPrintableArtifactBytes) {
    throw new Error("Printable artifact exceeds size limit")
  }
  const document = parse(content, { scriptingEnabled: false })
  sanitizeChildren(document, 0, { value: 0 })
  let output = serialize(document).replace(/^<!doctype html>/i, "")
  const safeTitle = escapeHtml(title.trim().slice(0, 200) || "Domovoi plan")
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><title>${safeTitle}</title><style>${printCss}</style>`
  output = output.replace("<head>", `<head>${head}`)
  output = output.replace("<body>", '<body><aside class="domovoi-safe-note" role="note">External resources and active content were removed for this safe offline copy.</aside>')
  const result = `<!doctype html>${output}`
  if (Buffer.byteLength(result, "utf8") > maximumPrintableArtifactBytes + 64_000) {
    throw new Error("Printable artifact exceeds output size limit")
  }
  return result
}

export function safeArtifactFilename(title: string): string {
  const stem = title.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, 80)
  return `${stem || "domovoi-plan"}.html`
}
