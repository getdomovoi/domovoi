import { posix, win32 } from "node:path"

export type DesktopPlatform = "darwin" | "linux" | "win32"

export type DesktopFileSystem = {
  realpath(path: string): Promise<string>
  stat(path: string): Promise<{
    isDirectory(): boolean
    isFile(): boolean
  }>
}

export type OpenDirectoryDialog = {
  showOpenDirectory(): Promise<{ canceled: boolean; filePaths: string[] }>
}

export type DesktopDirectoryResult =
  | { status: "cancelled" }
  | { status: "selected"; path: string }

const maximumPathLength = 4_096
const maximumClipboardLength = 1_000_000

function pathApi(platform: DesktopPlatform): typeof posix | typeof win32 {
  return platform === "win32" ? win32 : posix
}

export function isBoundedAbsolutePath(value: unknown, platform: DesktopPlatform): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximumPathLength
    && !/[\0\r\n]/u.test(value)
    && pathApi(platform).isAbsolute(value)
}

export async function chooseDirectory(
  dialog: OpenDirectoryDialog,
  fileSystem: DesktopFileSystem,
  platform: DesktopPlatform,
): Promise<DesktopDirectoryResult> {
  try {
    const result = await dialog.showOpenDirectory()
    if (result.canceled) return { status: "cancelled" }
    if (result.filePaths.length !== 1 || !isBoundedAbsolutePath(result.filePaths[0], platform)) {
      throw new Error("invalid selection")
    }
    const canonical = await fileSystem.realpath(result.filePaths[0])
    if (!isBoundedAbsolutePath(canonical, platform)) throw new Error("invalid canonical selection")
    const entry = await fileSystem.stat(canonical)
    if (!entry.isDirectory()) throw new Error("selection is not a directory")
    return { status: "selected", path: canonical }
  } catch {
    throw new Error("Domovoi could not use the selected folder. Choose another folder or check its permissions.")
  }
}

type ClipboardAdapter = {
  readText(): string | Promise<string>
  writeText(value: string): void | Promise<void>
}

function validatedClipboardText(value: unknown): string {
  if (typeof value !== "string") throw new Error("Clipboard text is invalid")
  if (value.length > maximumClipboardLength) throw new Error("Clipboard text is too large")
  return value
}

export class SafeClipboard {
  readonly #native: ClipboardAdapter

  constructor(adapter: ClipboardAdapter) {
    this.#native = adapter
  }

  async readText(): Promise<string> {
    let value: unknown
    try {
      value = await this.#native.readText()
    } catch {
      throw new Error("Clipboard text could not be read")
    }
    return validatedClipboardText(value)
  }

  async writeText(value: unknown): Promise<boolean> {
    const text = validatedClipboardText(value)
    try {
      await this.#native.writeText(text)
      return true
    } catch {
      throw new Error("Clipboard text could not be copied")
    }
  }
}

export type ExternalEditor = "system" | "vscode" | "vscode-insiders" | "cursor" | "zed"

export type ExternalOpenRequest = {
  editor: ExternalEditor
  path: string
}

type ExternalShell = {
  openPath(path: string): Promise<string>
  openExternal(url: string): Promise<void>
}

const editorSchemes = {
  vscode: "vscode",
  "vscode-insiders": "vscode-insiders",
  cursor: "cursor",
  zed: "zed",
} as const

function validExternalRequest(value: unknown, platform: DesktopPlatform): value is ExternalOpenRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const request = value as Record<string, unknown>
  if (Object.keys(request).sort().join(",") !== "editor,path") return false
  if (
    request.editor !== "system"
    && request.editor !== "vscode"
    && request.editor !== "vscode-insiders"
    && request.editor !== "cursor"
    && request.editor !== "zed"
  ) return false
  return isBoundedAbsolutePath(request.path, platform)
}

function pathInside(root: string, target: string, platform: DesktopPlatform): boolean {
  const relative = pathApi(platform).relative(root, target)
  return relative === "" || (!relative.startsWith("..") && !pathApi(platform).isAbsolute(relative))
}

export function editorUrlFor(
  editor: Exclude<ExternalEditor, "system">,
  path: string,
  platform: DesktopPlatform,
): string {
  const normalized = platform === "win32" ? path.replaceAll("\\", "/") : path
  const pathname = platform === "win32" && /^[A-Za-z]:\//u.test(normalized)
    ? `/${normalized}`
    : normalized
  const url = new URL(`${editorSchemes[editor]}://file`)
  url.pathname = pathname
  return url.toString().replace(/[$()]/gu, (character) =>
    `%${character.codePointAt(0)!.toString(16).toUpperCase()}`
  )
}

export class ExternalTargetController {
  readonly #allowedRoots = new Set<string>()

  constructor(
    private readonly native: ExternalShell,
    private readonly fileSystem: DesktopFileSystem,
    private readonly options: { platform: DesktopPlatform; allowedRoots: readonly string[] },
  ) {
    for (const root of options.allowedRoots) this.allowRoot(root)
  }

  allowRoot(path: string): void {
    if (isBoundedAbsolutePath(path, this.options.platform)) {
      this.#allowedRoots.add(pathApi(this.options.platform).normalize(path))
    }
  }

  async open(value: unknown): Promise<boolean> {
    if (!validExternalRequest(value, this.options.platform)) {
      throw new Error("External editor request is invalid")
    }

    let canonicalTarget: string
    let targetEntry: Awaited<ReturnType<DesktopFileSystem["stat"]>>
    const canonicalRoots: string[] = []
    try {
      canonicalTarget = await this.fileSystem.realpath(value.path)
      targetEntry = await this.fileSystem.stat(canonicalTarget)
      for (const root of this.#allowedRoots) {
        try {
          canonicalRoots.push(await this.fileSystem.realpath(root))
        } catch {
          // Roots may not exist until their first worktree is created.
        }
      }
    } catch {
      throw new Error("External editor request is not allowed")
    }
    if (
      !isBoundedAbsolutePath(canonicalTarget, this.options.platform)
      || (!targetEntry.isDirectory() && !targetEntry.isFile())
      || !canonicalRoots.some((root) => pathInside(root, canonicalTarget, this.options.platform))
    ) throw new Error("External editor request is not allowed")

    try {
      if (value.editor === "system") {
        const error = await this.native.openPath(canonicalTarget)
        if (error) throw new Error("native open failed")
      } else {
        await this.native.openExternal(editorUrlFor(value.editor, canonicalTarget, this.options.platform))
      }
      return true
    } catch {
      throw new Error("External editor could not open the item. Check the configured editor and try again.")
    }
  }
}
