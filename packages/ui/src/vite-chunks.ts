function packageNameFor(moduleId: string): string | undefined {
  const normalized = moduleId.replaceAll("\\", "/")
  const marker = "/node_modules/"
  const packagePath = normalized.slice(normalized.lastIndexOf(marker) + marker.length)
  if (!normalized.includes(marker) || packagePath.length === 0) return undefined
  const segments = packagePath.split("/")
  return segments[0]?.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]
}

export function vendorChunkFor(moduleId: string): string | undefined {
  const packageName = packageNameFor(moduleId)
  if (!packageName) return undefined
  if (["react", "react-dom", "scheduler"].includes(packageName)) return "react"
  if (packageName === "radix-ui" || packageName.startsWith("@radix-ui/")) return "ui"
  if (packageName === "lucide-react") return "icons"
  if (packageName === "react-resizable-panels") return "panels"
  if (packageName === "zod") return "validation"
  if (packageName.startsWith("@xterm/")) return "terminal"
  // Packages only a lazily loaded surface uses get a chunk of their own. In
  // the shared vendor chunk they would load at startup with everything else:
  // the pairing card's QR code draws only in Settings.
  if (packageName === "qrcode-generator") return "qrcode"
  return "vendor"
}
