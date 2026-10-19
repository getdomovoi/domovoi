import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// expo-modules-jsi builds its xcframework at app build time and strips the C++-only
// declarations from the public .swiftinterface with one sed program. Swift 6.4 prints
// module selectors (`__ObjC::expo`, `Swift::Error`), which the published SDK 57 pattern
// misses. patches/expo-modules-jsi@57.1.0.patch carries the expo-modules-jsi 58 program.
// These cases run that program from the installed, patched script.
describe.skipIf(process.platform === "win32")("expo-modules-jsi interface strip", () => {
  const requireFromExpo = createRequire(require.resolve("expo/package.json", { paths: [join(__dirname, "..")] }))
  const corePackage = requireFromExpo.resolve("expo-modules-core/package.json")
  const jsiPackage = createRequire(corePackage).resolve("expo-modules-jsi/package.json")
  const script = readFileSync(join(jsiPackage, "..", "apple", "scripts", "build-xcframework.sh"), "utf8")

  function strip(swiftinterface: string): string {
    const command = script.split("\n").find((line) => line.includes('> "$stripped_swiftinterface"'))
    if (!command) throw new Error("build-xcframework.sh has no swiftinterface strip command")
    const sedCommand = command.trim().replace(/ "\$swiftinterface" > "\$stripped_swiftinterface"$/, "")
    const result = spawnSync("sh", ["-c", sedCommand], { input: swiftinterface, encoding: "utf8" })
    expect(result.status, result.stderr).toBe(0)
    return result.stdout
  }

  const kept = ["public struct Kept {}", "public struct AlsoKept {}", ""].join("\n")

  it("strips the C++ error extension as Swift 6.3 prints it", () => {
    const out = strip(
      [
        "public struct Kept {}",
        "extension __ObjC.expo.CppError : Swift.Error {",
        "  public var message: Swift.String {",
        "    get",
        "  }",
        "}",
        "public struct AlsoKept {}",
        "",
      ].join("\n"),
    )
    expect(out).toBe(kept)
  })

  it("strips the C++ error extension as Swift 6.4 prints it", () => {
    const out = strip(
      [
        "public struct Kept {}",
        "extension __ObjC::expo.__ObjC::CppError : Swift::Error {",
        "  public var message: Swift::String {",
        "    get",
        "  }",
        "}",
        "public struct AlsoKept {}",
        "",
      ].join("\n"),
    )
    expect(out).toBe(kept)
  })

  it("drops the unavailable attribute Swift 6.4 prints before a package-internal conformance", () => {
    const next = "extension ExpoModulesJSI::JavaScriptRuntime.ExpoModulesJSI::SchedulerPriority : Swift::Equatable {}"
    const out = strip(
      [
        "@available(*, unavailable)",
        "extension Swift::Optional : ExpoModulesJSI::P where Wrapped : ExpoModulesJSI::_ConstraintThatIsNotPartOfTheAPIOfThisLibrary {}",
        next,
        "",
      ].join("\n"),
    )
    expect(out).toBe([next, ""].join("\n"))
  })
})
