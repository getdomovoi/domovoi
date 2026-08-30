import { describe, expect, it } from "vitest"

import {
  injectPreviewBridge,
  isSafePreviewSelector,
  validPreviewParentOrigin,
} from "./preview-bridge.js"

describe("injectPreviewBridge", () => {
  it("allows only picker-generated selector segments", () => {
    expect(isSafePreviewSelector("#hero_panel > section:nth-of-type(2)")).toBe(true)
    expect(isSafePreviewSelector("main > article")).toBe(true)
    expect(isSafePreviewSelector("#hero:has(script)")).toBe(false)
    expect(isSafePreviewSelector("main:is(body *)")).toBe(false)
    expect(isSafePreviewSelector("[data-anchor='target']")).toBe(false)
  })

  it("ignores closing-body text inside raw content", () => {
    const content = '<!doctype html><html><body><script>const marker = "</body>"; const prefix = "</scripture></body>"</script><textarea></body></textarea><iframe></body></iframe><noscript></body></noscript><template><section></body></section></template><svg><![CDATA[</body>]]></svg><main>Preview</main></body></html>'
    const injected = injectPreviewBridge(
      content,
      "artifact-preview",
      "preview_channel_123456",
      "https://app.domovoi.sh",
    )

    expect(injected.indexOf("data-domovoi-preview-bridge")).toBeGreaterThan(
      injected.indexOf("<main>Preview</main>"),
    )
    expect(injected.indexOf("data-domovoi-preview-bridge")).toBeLessThan(
      injected.lastIndexOf("</body>"),
    )
    expect(injected).toContain('if(element===document.documentElement)return "html"')
    expect(injected).toContain('event.origin!==parentOrigin')
    expect(injected).toContain('parentOrigin="https://app.domovoi.sh"')
    expect(injected).toContain('message.type==="domovoi.preview.resolve-anchors"')
    expect(injected).toContain('type:"domovoi.preview.anchor-resolutions"')
    expect(injected).toContain("MAX_ANCHORS=100")
    expect(injected).toContain("MAX_CANDIDATES=1500")
    expect(injected).toContain("MAX_TEXT_QUOTE=2000")
    expect(injected).toContain(".slice(0,MAX_TEXT_QUOTE)")
    expect(injected).toContain("const isSafePreviewSelector=")
    expect(injected).toContain("setActive(false);")
    const script = injected.match(/<script data-domovoi-preview-bridge>([\s\S]*?)<\/script>/)?.[1]
    expect(script).toBeDefined()
    expect(() => new Function(script!)).not.toThrow()
  })

  it("injects before plaintext consumes the rest of the document", () => {
    const content = "<!doctype html><html><body><main>Preview</main><plaintext></body></html>"
    const injected = injectPreviewBridge(
      content,
      "artifact-preview",
      "preview_channel_123456",
      "null",
    )

    expect(injected.indexOf("data-domovoi-preview-bridge")).toBeGreaterThan(
      injected.indexOf("<main>Preview</main>"),
    )
    expect(injected.indexOf("data-domovoi-preview-bridge")).toBeLessThan(
      injected.indexOf("<plaintext>"),
    )
  })

  it("accepts serialized web and opaque parent origins only", () => {
    expect(validPreviewParentOrigin("https://app.domovoi.sh")).toBe("https://app.domovoi.sh")
    expect(validPreviewParentOrigin("http://127.0.0.1:5178")).toBe("http://127.0.0.1:5178")
    expect(validPreviewParentOrigin("null")).toBe("null")
    expect(validPreviewParentOrigin("https://app.domovoi.sh/path")).toBeUndefined()
    expect(validPreviewParentOrigin("javascript:alert(1)")).toBeUndefined()
  })
})
