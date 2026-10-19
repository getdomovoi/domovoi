import { platform } from "node:os"

import { spawn } from "node-pty"
import { afterEach, describe, expect, it, vi } from "vitest"

import { NodePtyTerminalService } from "./terminal"

vi.mock("node:os", () => ({ platform: vi.fn() }))
vi.mock("node-pty", () => ({ spawn: vi.fn() }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function expectShellEnvironment(
  targetPlatform: NodeJS.Platform,
  locale: NodeJS.ProcessEnv,
  expectedLocale: NodeJS.ProcessEnv,
): void {
  const environment = { PATH: "/test/bin", TERM: "dumb", ...locale }
  const original = { ...environment }
  vi.stubGlobal("process", { ...process, env: environment })
  vi.mocked(platform).mockReturnValue(targetPlatform)

  new NodePtyTerminalService().spawn({ cwd: "/project", cols: 80, rows: 24 })

  expect(spawn).toHaveBeenCalledExactlyOnceWith(
    targetPlatform === "win32" ? "powershell.exe" : "/bin/sh",
    [],
    {
      name: "xterm-256color",
      cwd: "/project",
      cols: 80,
      rows: 24,
      env: { PATH: "/test/bin", TERM: "xterm-256color", ...expectedLocale },
      ...(targetPlatform === "win32" ? { useConpty: true } : {}),
    },
  )
  expect(environment).toEqual(original)
}

describe.each([
  ["darwin", "en_US.UTF-8"],
  ["linux", "C.UTF-8"],
] as const)("%s terminal shell locale", (targetPlatform, fallback) => {
  it("supplies UTF-8 when locale variables are absent", () => {
    expectShellEnvironment(targetPlatform, {}, { LANG: fallback })
  })

  it("supplies UTF-8 when locale variables are empty", () => {
    const locale = { LANG: "", LC_ALL: "", LC_CTYPE: "" }
    expectShellEnvironment(targetPlatform, locale, { ...locale, LANG: fallback })
  })

  it.each(["LC_ALL", "LC_CTYPE", "LANG"])("preserves a non-empty %s", (name) => {
    const locale = { LANG: "", LC_ALL: "", LC_CTYPE: "", [name]: "C" }
    expectShellEnvironment(targetPlatform, locale, locale)
  })

  it("preserves conflicting explicit locale values", () => {
    const locale = { LC_ALL: "C", LC_CTYPE: "ja_JP.UTF-8", LANG: "de_DE.ISO-8859-1" }
    expectShellEnvironment(targetPlatform, locale, locale)
  })

  it("does not trim a user-supplied locale", () => {
    const locale = { LC_CTYPE: " " }
    expectShellEnvironment(targetPlatform, locale, locale)
  })

  it("retains unrelated locale categories while supplying UTF-8", () => {
    const locale = { LC_TIME: "de_DE.UTF-8" }
    expectShellEnvironment(targetPlatform, locale, { ...locale, LANG: fallback })
  })
})

describe("platforms without a terminal locale fallback", () => {
  it.each([{}, { LANG: "", LC_ALL: "", LC_CTYPE: "" }, { LANG: "C" }])(
    "preserves the Windows environment %j",
    (locale) => { expectShellEnvironment("win32", locale, locale) },
  )

  it("does not assume a locale on other Unix platforms", () => {
    expectShellEnvironment("freebsd", {}, {})
  })
})
