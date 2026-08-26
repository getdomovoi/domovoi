import { describe, expect, it } from "vitest"

import { injectPreviewBridge } from "./preview-bridge.js"

describe("injectPreviewBridge", () => {
  it("ignores closing-body text inside raw content", () => {
    const content = '<!doctype html><html><body><script>const marker = "</body>"; const prefix = "</scripture></body>"</script><textarea></body></textarea><iframe></body></iframe><noscript></body></noscript><template><section></body></section></template><svg><![CDATA[</body>]]></svg><main>Preview</main></body></html>'
    const injected = injectPreviewBridge(content, "artifact-preview", "preview_channel_123456")

    expect(injected.indexOf("data-domovoi-preview-bridge")).toBeGreaterThan(
      injected.indexOf("<main>Preview</main>"),
    )
    expect(injected.indexOf("data-domovoi-preview-bridge")).toBeLessThan(
      injected.lastIndexOf("</body>"),
    )
    expect(injected).toContain('if(element===document.documentElement)return "html"')
  })

  it("injects before plaintext consumes the rest of the document", () => {
    const content = "<!doctype html><html><body><main>Preview</main><plaintext></body></html>"
    const injected = injectPreviewBridge(content, "artifact-preview", "preview_channel_123456")

    expect(injected.indexOf("data-domovoi-preview-bridge")).toBeGreaterThan(
      injected.indexOf("<main>Preview</main>"),
    )
    expect(injected.indexOf("data-domovoi-preview-bridge")).toBeLessThan(
      injected.indexOf("<plaintext>"),
    )
  })
})
