import { installDaemonService } from "@getdomovoi/daemon"
import { describe, expect, it, vi } from "vitest"

import { createDesktopWindowBridge, type IpcRendererAdapter } from "./desktop-bridge.js"

function ipc() {
  const handlers = new Map<string, (event: unknown, value: unknown) => void>()
  const target = {
    handlers,
    invoke: vi.fn(async (channel: string): Promise<unknown> => {
      if (channel === "domovoi:open-directory") return { status: "selected", path: "/project" }
      if (channel === "domovoi:clipboard-read") return "clipboard"
      return true
    }),
    send: vi.fn((_channel: string, ..._args: unknown[]) => {}),
    on: vi.fn((channel, handler) => { handlers.set(channel, handler) }),
    removeListener: vi.fn((channel) => { handlers.delete(channel) }),
  }
  return target satisfies IpcRendererAdapter & { handlers: typeof handlers }
}

describe("createDesktopWindowBridge", () => {
  // Review of #698 round 4 (P2): the daemon's installer composes the warning
  // from loginctl's own diagnostic, and this check refuses service text over
  // 4,096 UTF-16 units. A long diagnostic must still reach the renderer as a
  // successful install that carries the warning. The installer runs on fakes.
  it("accepts the real installer's lingering warning after a long loginctl diagnostic", async () => {
    const capture = vi.fn(async (command: string, args: string[]) => command === "loginctl" && args[0] === "show-user"
      ? { code: 1, stdout: "", stderr: `Failed to connect to bus: ${"x".repeat(4_600)}` } : { code: 0, stdout: "" })
    const installed = await installDaemonService({
      runtime: { nodePath: "/opt/domovoi/runtime/node", daemonEntryPath: "/opt/domovoi/runtime/daemon/dist/index.js" },
    }, {
      platform: "linux", home: "/home/dana", uid: 1000, user: "dana",
      runtimeFile: vi.fn(async () => "file" as const),
      claimServiceOperation: vi.fn(() => ({ release: vi.fn() })),
      claimProfile: vi.fn(() => ({ release: vi.fn() })),
      removalSnapshot: vi.fn(() => ({ owner: undefined, configurationDigest: null })),
      writeRemovalReceipt: vi.fn(),
      write: vi.fn(async () => {}),
      run: vi.fn(async () => {}),
      capture,
      exists: vi.fn(async () => true),
      remove: vi.fn(async () => {}),
    })
    if (installed.kind !== "file" || installed.lingerWarning === undefined) throw new Error("expected a lingering warning")
    const target = ipc()
    target.invoke.mockImplementationOnce(async () => ({
      ok: true, kind: "file", target: installed.path, configurationPath: installed.configurationPath, daemonRunning: true, lingerWarning: installed.lingerWarning,
    }))
    const answer = await createDesktopWindowBridge(target, "linux").daemonService?.install()
    expect(answer).toEqual({ ok: true, kind: "file", target: installed.path, daemonRunning: true, lingerWarning: installed.lingerWarning })
    expect(installed.lingerWarning).toContain("systemd stops the daemon when dana logs out of every session")
    expect(installed.lingerWarning).toContain("To keep it running, run loginctl enable-linger")
  })

  it("exposes typed narrow IPC methods instead of Electron", async () => {
    const target = ipc()
    const bridge = createDesktopWindowBridge(target, "linux")

    await expect(bridge.openDirectory()).resolves.toEqual({ status: "selected", path: "/project" })
    await expect(bridge.readClipboardText()).resolves.toBe("clipboard")
    await expect(bridge.writeClipboardText("copy me")).resolves.toBe(true)
    await expect(bridge.openExternal({ editor: "system", path: "/project" })).resolves.toBe(true)
    expect(target.invoke).toHaveBeenCalledWith("domovoi:clipboard-write", "copy me")
    expect(target.invoke).toHaveBeenCalledWith("domovoi:open-external", { editor: "system", path: "/project" })
    target.invoke.mockImplementationOnce(async () => ({ ok: true, kind: "file", target: "/Users/dana/Library/LaunchAgents/sh.domovoi.daemon.plist", configurationPath: "/c", daemonRunning: true }))
    await expect(bridge.daemonService?.install()).resolves.toEqual({ ok: true, kind: "file", target: "/Users/dana/Library/LaunchAgents/sh.domovoi.daemon.plist", daemonRunning: true })
    // Ruling Q307 (review of #698, P2): the daemon's lingering warning reaches
    // the renderer; one that is not text is refused like any other field.
    target.invoke.mockImplementationOnce(async () => ({ ok: true, kind: "file", target: "/u", configurationPath: "/c", daemonRunning: true, lingerWarning: "Could not turn on lingering for dana: loginctl was not found." }))
    await expect(bridge.daemonService?.install()).resolves.toEqual({ ok: true, kind: "file", target: "/u", daemonRunning: true, lingerWarning: "Could not turn on lingering for dana: loginctl was not found." })
    target.invoke.mockImplementationOnce(async () => ({ ok: true, kind: "file", target: "/u", daemonRunning: true, lingerWarning: 5 }))
    await expect(bridge.daemonService?.install()).rejects.toThrow("invalid service outcome")
    // The length bound and the other optional fields are refused the same way.
    for (const field of [{ lingerWarning: "x".repeat(4_097) }, { daemonAttached: "yes" }, { profileRecovery: "guessed" }]) {
      target.invoke.mockImplementationOnce(async () => ({ ok: true, kind: "file", target: "/u", daemonRunning: true, ...field }))
      await expect(bridge.daemonService?.install()).rejects.toThrow("invalid service outcome")
    }
    target.invoke.mockImplementationOnce(async () => ({ ok: true, kind: "file", target: "/u", daemonRunning: true, lingerWarning: "x".repeat(4_096) }))
    await expect(bridge.daemonService?.install()).resolves.toMatchObject({ lingerWarning: "x".repeat(4_096) })
    for (const [answer, drawn] of [
      [{ ok: true, kind: "task", target: "\\Domovoi\\domovoid", profileRecovery: "proof-unavailable", profileRecoveryDetail: "The service record could not be read", daemonRunning: false },
        { ok: true, kind: "task", target: "\\Domovoi\\domovoid", profileRecovery: "proof-unavailable", profileRecoveryDetail: "The service record could not be read", daemonRunning: false }],
      [{ ok: true, kind: "file", target: "/p", profileRecovery: "operator-confirmation-required", daemonRunning: true },
        { ok: true, kind: "file", target: "/p", profileRecovery: "operator-confirmation-required", daemonRunning: true }],
      [{ ok: false, reason: "installed-not-attached", kind: "file", target: "/p", message: "The daemon did not answer" },
        { ok: false, reason: "installed-not-attached", kind: "file", target: "/p", message: "The daemon did not answer" }],
      [{ ok: false, reason: "refused", message: "1 gate is waiting (Fix login)." }, { ok: false, reason: "refused", message: "1 gate is waiting (Fix login)." }],
      [{ ok: false, reason: "check-failed", message: "connect ECONNREFUSED" }, { ok: false, reason: "check-failed", message: "connect ECONNREFUSED" }],
      [{ ok: false, reason: "failed", message: "launchctl bootstrap exited 5", daemon: "stopped", service: { installed: false, running: false } }, { ok: false, reason: "failed", message: "launchctl bootstrap exited 5", daemon: "stopped", service: { installed: false, running: false } }],
    ] as const) {
      target.invoke.mockImplementationOnce(async () => answer)
      await expect(bridge.daemonService?.remove()).resolves.toEqual(drawn)
    }
    for (const answer of [
      { ok: true, kind: "file", target: "/p" },
      { ok: true, kind: "file", target: "/p", daemonRunning: true, profileRecovery: "whatever" },
      { ok: false, reason: "failed", message: "m", daemon: "maybe" },
    ]) {
      target.invoke.mockImplementationOnce(async () => answer)
      await expect(bridge.daemonService?.remove()).rejects.toThrow("invalid service outcome")
    }
    // Ruled 2026-09-23 (#577, B): the in-place update, with the daemon's own words on failure.
    target.invoke.mockImplementationOnce(async () => ({ ok: true, kind: "file", target: "/p", configurationPath: "/c", daemonRunning: true }))
    await expect(bridge.daemonService?.update()).resolves.toEqual({ ok: true, kind: "file", target: "/p", daemonRunning: true })
    expect(target.invoke).toHaveBeenLastCalledWith("domovoi:daemon-service-update")
    target.invoke.mockImplementationOnce(async () => ({ ok: false, reason: "update-failed", message: "The previous service was put back and is running." }))
    await expect(bridge.daemonService?.update()).resolves.toEqual({ ok: false, reason: "update-failed", message: "The previous service was put back and is running." })
    target.invoke.mockImplementationOnce(async () => ({ ok: false, reason: "update-failed" }))
    await expect(bridge.daemonService?.update()).rejects.toThrow("invalid service outcome")
    target.invoke.mockImplementationOnce(async () => ({ installed: true, running: true, detail: "pid 1" }))
    await expect(bridge.daemonService?.status()).resolves.toEqual({ installed: true, running: true, detail: "pid 1" })
    target.invoke.mockImplementationOnce(async () => ({ nonsense: true }))
    await expect(bridge.daemonService?.remove()).rejects.toThrow("invalid service outcome")
    await expect(bridge.openReleasePage?.()).resolves.toBe(true)
    expect(target.invoke).toHaveBeenCalledWith("domovoi:open-release-page")
    // Q336 A: the action is all the renderer names; the renderer validates
    // the answer (packages/ui/src/printed-command.ts), keeping the preload
    // inside its budget.
    target.invoke.mockImplementationOnce(async () => ({ report: { available: false, reason: "r" } }))
    await expect(bridge.commandLinks?.("status")).resolves.toEqual({ report: { available: false, reason: "r" } })
    expect(target.invoke).toHaveBeenLastCalledWith("domovoi:command-links", "status")
    expect(bridge).not.toHaveProperty("ipcRenderer")
    expect(bridge).not.toHaveProperty("shell")
    expect(bridge).not.toHaveProperty("clipboard")
  })

  // Security review round 1 of #576: a removal says whether the daemon this
  // app reaches afterwards is one it did not start, and a failure carries the
  // service as read back afterwards (null when it could not be read).
  it("passes a removal's attachment and a failure's service read-back through, and refuses them malformed", async () => {
    const target = ipc()
    const bridge = createDesktopWindowBridge(target, "linux")
    for (const answer of [
      { ok: true, kind: "file", target: "/p", profileRecovery: "not-needed", daemonRunning: true, daemonAttached: true },
      { ok: true, kind: "file", target: "/p", profileRecovery: "not-needed", daemonRunning: true, daemonAttached: false },
      { ok: false, reason: "failed", message: "m", daemon: "attached", service: { installed: true, running: false } },
      { ok: false, reason: "failed", message: "m", daemon: "restarted", service: null },
      { ok: false, reason: "failed", message: "m", daemon: "untouched", service: { installed: null, running: false } },
    ]) {
      target.invoke.mockImplementationOnce(async () => answer)
      await expect(bridge.daemonService?.remove()).resolves.toEqual(answer)
    }
    for (const answer of [
      { ok: false, reason: "failed", message: "m", daemon: "stopped" },
      { ok: false, reason: "failed", message: "m", daemon: "stopped", service: { installed: "yes", running: false } },
      { ok: false, reason: "failed", message: "m", daemon: "stopped", service: { installed: true } },
      { ok: true, kind: "file", target: "/p", daemonRunning: true, daemonAttached: "yes" },
    ]) {
      target.invoke.mockImplementationOnce(async () => answer)
      await expect(bridge.daemonService?.remove()).rejects.toThrow("invalid service outcome")
    }
  })

  it("hands the renderer the endpoint of the daemon the main process acquired", async () => {
    const target = ipc()
    const bridge = createDesktopWindowBridge(target, "linux")
    const owned = { kind: "owned", url: "wss://[::1]:50123/rpc", token: "factory-token" }
    const attached = { kind: "attached", owner: "daemon", url: "ws://127.0.0.1:47831/rpc", token: "file-token" }

    target.invoke.mockResolvedValueOnce(owned)
    await expect(bridge.getRpcEndpoint()).resolves.toEqual({ url: "wss://[::1]:50123/rpc", token: "factory-token" })
    expect(target.invoke).toHaveBeenCalledWith("domovoi:rpc-endpoint")

    target.invoke.mockResolvedValueOnce(attached)
    await expect(bridge.getRpcEndpoint()).resolves.toEqual({ url: "ws://127.0.0.1:47831/rpc", token: "file-token" })

    target.invoke.mockResolvedValueOnce(owned)
    await expect(bridge.acquireDaemon()).resolves.toEqual(owned)
    target.invoke.mockResolvedValueOnce(attached)
    await expect(bridge.acquireDaemon()).resolves.toEqual(attached)
    expect(target.invoke).not.toHaveBeenCalledWith("domovoi:rpc-endpoint-reconnect")

    target.invoke.mockResolvedValueOnce(attached)
    await expect(bridge.reacquireDaemon()).resolves.toEqual(attached)
    expect(target.invoke).toHaveBeenLastCalledWith("domovoi:rpc-endpoint-reconnect")
  })

  it("carries a refusal with the daemon's reason and message", async () => {
    const target = ipc()
    const bridge = createDesktopWindowBridge(target, "linux")
    const refusal = { kind: "refused", reason: "owner-unreachable", message: "The profile has no reachable owner." }

    target.invoke.mockResolvedValueOnce(refusal)
    await expect(bridge.acquireDaemon()).resolves.toEqual(refusal)
    target.invoke.mockResolvedValueOnce(refusal)
    await expect(bridge.reacquireDaemon()).resolves.toEqual(refusal)
    target.invoke.mockResolvedValueOnce(refusal)
    await expect(bridge.getRpcEndpoint()).rejects.toThrow("The profile has no reachable owner.")
  })

  it("rejects a daemon acquisition that is not a described bearer token for a websocket URL", async () => {
    const target = ipc()
    const bridge = createDesktopWindowBridge(target, "linux")

    for (const reply of [
      "factory-token",
      null,
      [{ kind: "owned", url: "ws://127.0.0.1:47831/rpc", token: "factory-token" }],
      { url: "ws://127.0.0.1:47831/rpc", token: "factory-token" },
      { kind: "started", url: "ws://127.0.0.1:47831/rpc", token: "factory-token" },
      { kind: "owned", url: "ws://127.0.0.1:47831/rpc" },
      { kind: "owned", token: "factory-token" },
      { kind: "owned", url: "ws://127.0.0.1:47831/rpc", token: "" },
      { kind: "owned", url: "ws://127.0.0.1:47831/rpc", token: "t".repeat(4_097) },
      { kind: "owned", url: "", token: "factory-token" },
      { kind: "owned", url: "http://127.0.0.1:47831/rpc", token: "factory-token" },
      { kind: "owned", url: "not a url", token: "factory-token" },
      { kind: "owned", url: "ws://127.0.0.1:47831/rpc", token: "factory-token", host: "127.0.0.1" },
      { kind: "owned", owner: "daemon", url: "ws://127.0.0.1:47831/rpc", token: "factory-token" },
      { kind: "attached", url: "ws://127.0.0.1:47831/rpc", token: "factory-token" },
      { kind: "attached", owner: "service", url: "ws://127.0.0.1:47831/rpc", token: "factory-token" },
      { kind: "attached", owner: "daemon", url: "http://127.0.0.1:47831/rpc", token: "factory-token" },
      { kind: "refused", reason: "owner-unreachable" },
      { kind: "refused", reason: "owner-unreachable", message: "" },
      { kind: "refused", reason: "owner-unreachable", message: "m".repeat(1_001) },
      { kind: "refused", reason: "owner-asleep", message: "The profile has no reachable owner." },
      { kind: "refused", reason: "owner-unreachable", message: "The profile has no reachable owner.", url: "ws://127.0.0.1:47831/rpc" },
    ]) {
      target.invoke.mockResolvedValueOnce(reply)
      await expect(bridge.acquireDaemon()).rejects.toThrow("Desktop returned an invalid daemon endpoint")
      target.invoke.mockResolvedValueOnce(reply)
      await expect(bridge.getRpcEndpoint()).rejects.toThrow("Desktop returned an invalid daemon endpoint")
    }
  })

  it("validates renderer inputs before IPC", async () => {
    const target = ipc()
    const bridge = createDesktopWindowBridge(target, "win32")
    await expect(bridge.writeClipboardText("x".repeat(1_000_001))).rejects.toThrow("Clipboard text is too large")
    await expect(bridge.openExternal({ editor: "system", path: "relative" })).rejects.toThrow(
      "External editor request is invalid",
    )
    expect(target.invoke).not.toHaveBeenCalledWith("domovoi:clipboard-write", expect.anything())
  })

  it("reports the running window decoration and refuses unknown values", async () => {
    const decorations: unknown[] = ["system", "gnome"]
    const target = {
      invoke: vi.fn(async () => decorations.shift()),
      send: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    } satisfies IpcRendererAdapter
    const bridge = createDesktopWindowBridge(target, "linux")

    await expect(bridge.getWindowDecoration()).resolves.toBe("system")
    await expect(bridge.getWindowDecoration()).rejects.toThrow(
      "Desktop returned an invalid window decoration",
    )
  })

  it("validates a window decoration before persisting it", async () => {
    const target = ipc()
    const bridge = createDesktopWindowBridge(target, "linux")

    await expect(bridge.setWindowDecoration("system")).resolves.toBe(true)
    expect(target.invoke).toHaveBeenCalledWith("domovoi:window-decoration-set", "system")

    await expect(
      bridge.setWindowDecoration("gnome" as never),
    ).rejects.toThrow("Window decoration is invalid")
    expect(target.invoke).toHaveBeenCalledTimes(1)
  })

  it("validates annotation capture replies before they reach the renderer", async () => {
    const target = ipc()
    const bridge = createDesktopWindowBridge(target, "linux")
    const rect = { x: 0, y: 0, width: 320, height: 120 }
    const capture = { mimeType: "image/png", width: 320, height: 120, data: "AAAA" }

    target.invoke.mockResolvedValueOnce(capture)
    await expect(bridge.captureAnnotation(rect)).resolves.toEqual(capture)
    expect(target.invoke).toHaveBeenCalledWith("domovoi:capture-annotation", rect)

    for (const reply of [
      "AAAA",
      null,
      [capture],
      { mimeType: "image/jpeg", width: 320, height: 120, data: "AAAA" },
      { mimeType: "image/jpeg" },
      { mimeType: "image/png", width: 0, height: 120, data: "AAAA" },
      { mimeType: "image/png", width: 320, height: 2049, data: "AAAA" },
      { mimeType: "image/png", width: 320.5, height: 120, data: "AAAA" },
      { mimeType: "image/png", width: 320, height: 120, data: "" },
      { mimeType: "image/png", width: 320, height: 120, data: "A".repeat(2_000_001) },
      { mimeType: "image/png", width: 320, height: 120, data: "AAAA", extra: true },
    ]) {
      target.invoke.mockResolvedValueOnce(reply)
      await expect(bridge.captureAnnotation(rect)).rejects.toThrow(
        "Desktop returned an invalid annotation capture response",
      )
    }
  })

  it("routes only bounded deep-link session IDs and removes its listener", () => {
    const target = ipc()
    const bridge = createDesktopWindowBridge(target, "darwin")
    const listener = vi.fn()
    const dispose = bridge.onDeepLink(listener)
    expect(target.send).toHaveBeenCalledWith("domovoi:deep-link-ready")

    target.handlers.get("domovoi:deep-link")?.({ sender: "hidden" }, "session-one")
    target.handlers.get("domovoi:deep-link")?.({ sender: "hidden" }, "../private")
    target.handlers.get("domovoi:deep-link")?.({ sender: "hidden" }, "a".repeat(129))
    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith("session-one")

    dispose()
    expect(target.send).toHaveBeenCalledWith("domovoi:deep-link-paused")
    expect(target.removeListener).toHaveBeenCalledWith("domovoi:deep-link", expect.any(Function))
  })

  // TailnetReach (Q404 A). The preload passes the main process's answer on
  // only when it holds known keys, booleans and bounded strings, two levels
  // deep; the renderer parses its exact shape (packages/ui tailnet-reach.ts).
  it("asks the main process for one of three tailnet actions and passes a plain answer on", async () => {
    const target = ipc()
    const report = { state: "on", name: "studio.tail4c2e.ts.net", address: "100.101.102.103", stored: "~/.domovoi/tls/studio.tail4c2e.ts.net.crt, .key", httpsCertificates: true, renewalFailed: { at: "2026-10-02T12:00:00.000Z", message: "x" }, handSet: "x" }
    target.invoke.mockImplementation(async () => report)
    const bridge = createDesktopWindowBridge(target, "darwin")
    for (const action of ["status", "on", "off"] as const) {
      await expect(bridge.tailnetReach?.(action)).resolves.toEqual(report)
      expect(target.invoke).toHaveBeenLastCalledWith("domovoi:tailnet-reach", action)
    }
    const outcome = { ok: false, reason: "failed", step: "certificate", message: "Tailscale did not issue a certificate.", detail: "x" }
    target.invoke.mockImplementation(async () => outcome)
    await expect(bridge.tailnetReach?.("on")).resolves.toEqual(outcome)
  })

  it.each([
    ["an unknown key", { state: "off", path: "/etc" }],
    ["an empty string", { state: "" }],
    ["an oversized string", { state: "off", detail: "x".repeat(4_097) }],
    ["a number", { state: "off", port: 443 }],
    ["an array", { state: "off", name: ["a"] }],
    ["a third level", { ok: true, report: { renewalFailed: { at: { deep: "x" } } } }],
    ["no object", "on"],
    ["null", null],
  ])("refuses an answer with %s", async (_label, answer) => {
    const target = ipc()
    target.invoke.mockImplementation(async () => answer)
    await expect(createDesktopWindowBridge(target, "darwin").tailnetReach?.("status")).rejects.toThrow("Desktop returned an invalid tailnet answer")
  })

  it("asks nothing for an action it does not know", async () => {
    const target = ipc()
    const bridge = createDesktopWindowBridge(target, "darwin")
    await expect(bridge.tailnetReach?.("renew" as "on")).rejects.toThrow("Desktop received an invalid tailnet action")
    expect(target.invoke).not.toHaveBeenCalled()
  })
})
