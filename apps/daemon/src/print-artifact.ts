import { defaultTreeAdapter, html, parse, serialize, type DefaultTreeAdapterTypes } from "parse5"

import { performanceBudgets } from "@getdomovoi/protocol"

export const maximumPrintableArtifactBytes = performanceBudgets.largePreviews.sourceBytes
export const maximumPrintableArtifactNodes = performanceBudgets.largePreviews.printableNodes
export const maximumPrintableArtifactDepth = performanceBudgets.largePreviews.printableDepth

export type PrintableArtifactErrorCode = "source-size" | "tree-depth" | "tree-nodes" | "output-size" | "derivation"

export class PrintableArtifactError extends Error {
  readonly kind: "limit" | "derivation"

  constructor(readonly code: PrintableArtifactErrorCode, message: string) {
    super(message)
    this.name = "PrintableArtifactError"
    this.kind = code === "derivation" ? "derivation" : "limit"
  }
}

const removedElements = new Set([
  "script", "iframe", "object", "embed", "input", "button", "select", "textarea",
  "link", "base", "meta", "canvas", "audio", "video", "source", "track", "picture",
  "portal", "frame", "frameset", "applet", "foreignobject", "animate", "set",
  "animatetransform", "animatemotion", "discard", "title",
])
const unwrappedElements = new Set(["form"])
const networkAttributes = new Set([
  "src", "srcset", "poster", "background", "data", "action", "formaction", "ping",
  "xlink:href",
])

function normalizedTagName(element: DefaultTreeAdapterTypes.Element): string {
  return element.tagName.toLowerCase()
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
  const tagName = normalizedTagName(element)
  const nextAttributes: typeof element.attrs = []
  let safeHref: string | undefined
  for (const attribute of element.attrs) {
    const name = attribute.name.toLowerCase()
    if (name.startsWith("on") || networkAttributes.has(name) || name === "autofocus" || name === "contenteditable") continue
    if (name === "href") {
      if (tagName === "a") safeHref = safeLink(attribute.value)
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
  if (tagName === "a" && safeHref) {
    nextAttributes.push({ name: "href", value: safeHref })
    if (!safeHref.startsWith("#")) {
      nextAttributes.push({ name: "target", value: "_blank" })
      nextAttributes.push({ name: "rel", value: "noopener noreferrer" })
    }
  }
  element.attrs = nextAttributes
  if (tagName === "style") {
    for (const child of element.childNodes) {
      if ("value" in child && typeof child.value === "string") child.value = sanitizeCss(child.value)
    }
  }
}

function sanitizeChildren(parent: DefaultTreeAdapterTypes.ParentNode, depth: number, counter: { value: number }): void {
  if (depth > maximumPrintableArtifactDepth) throw new PrintableArtifactError("tree-depth", "Printable artifact exceeds depth limit")
  const children: DefaultTreeAdapterTypes.ChildNode[] = []
  for (const child of parent.childNodes) {
    counter.value += 1
    if (counter.value > maximumPrintableArtifactNodes) throw new PrintableArtifactError("tree-nodes", "Printable artifact exceeds node limit")
    if ("tagName" in child) {
      const tagName = normalizedTagName(child)
      if (removedElements.has(tagName)) continue
      sanitizeElement(child)
      sanitizeChildren(child, depth + 1, counter)
      if (unwrappedElements.has(tagName)) {
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

function directElement(parent: DefaultTreeAdapterTypes.ParentNode, tagName: string): DefaultTreeAdapterTypes.Element | undefined {
  return parent.childNodes.find(
    (child): child is DefaultTreeAdapterTypes.Element => "tagName" in child && normalizedTagName(child) === tagName,
  )
}

function htmlElement(tagName: string, attrs: Array<{ name: string; value: string }> = []): DefaultTreeAdapterTypes.Element {
  return defaultTreeAdapter.createElement(tagName, html.NS.HTML, attrs)
}

function appendTextElement(parent: DefaultTreeAdapterTypes.ParentNode, tagName: string, value: string): void {
  const element = htmlElement(tagName)
  defaultTreeAdapter.appendChild(element, defaultTreeAdapter.createTextNode(value))
  defaultTreeAdapter.appendChild(parent, element)
}

function insertDerivedNodes(document: DefaultTreeAdapterTypes.Document, title: string): void {
  defaultTreeAdapter.setDocumentType(document, "html", "", "")
  const doctype = document.childNodes.find((child) => child.nodeName === "#documentType")
  if (doctype) document.childNodes = [doctype, ...document.childNodes.filter((child) => child !== doctype)]

  const root = directElement(document, "html")
  const head = root ? directElement(root, "head") : undefined
  const body = root ? directElement(root, "body") : undefined
  if (!head || !body) throw new PrintableArtifactError("derivation", "Printable artifact structure could not be derived")

  defaultTreeAdapter.appendChild(head, htmlElement("meta", [{ name: "charset", value: "utf-8" }]))
  defaultTreeAdapter.appendChild(head, htmlElement("meta", [
    { name: "http-equiv", value: "Content-Security-Policy" },
    { name: "content", value: "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'" },
  ]))
  defaultTreeAdapter.appendChild(head, htmlElement("meta", [{ name: "name", value: "referrer" }, { name: "content", value: "no-referrer" }]))
  appendTextElement(head, "title", title.trim().slice(0, 200) || "Domovoi plan")
  appendTextElement(head, "style", printCss)

  const note = htmlElement("aside", [{ name: "class", value: "domovoi-safe-note" }, { name: "role", value: "note" }])
  defaultTreeAdapter.appendChild(note, defaultTreeAdapter.createTextNode("External resources and active content were removed for this safe offline copy."))
  const firstChild = body.childNodes[0]
  if (firstChild) defaultTreeAdapter.insertBefore(body, note, firstChild)
  else defaultTreeAdapter.appendChild(body, note)
}

export function sanitizePrintableArtifact(content: string, title: string): string {
  if (Buffer.byteLength(content, "utf8") > maximumPrintableArtifactBytes) {
    throw new PrintableArtifactError("source-size", "Printable artifact exceeds size limit")
  }
  try {
    const document = parse(content, { scriptingEnabled: false })
    sanitizeChildren(document, 0, { value: 0 })
    insertDerivedNodes(document, title)
    const result = serialize(document)
    if (Buffer.byteLength(result, "utf8") > maximumPrintableArtifactBytes + 64_000) {
      throw new PrintableArtifactError("output-size", "Printable artifact exceeds output size limit")
    }
    return result
  } catch (error) {
    if (error instanceof PrintableArtifactError) throw error
    throw new PrintableArtifactError("derivation", "Printable artifact could not be derived")
  }
}

export function safeArtifactFilename(title: string): string {
  const stem = title.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, 80)
  return `${stem || "domovoi-plan"}.html`
}
