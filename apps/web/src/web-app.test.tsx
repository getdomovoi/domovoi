// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { BrowserPlatformEnvironment } from "./browser-platform"
import type { BearerPairingClient, CodePairingClient, PairingClientFactory } from "./daemon-pairing"
import { WebApp, type WebAppProps } from "./web-app"

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

const rpcUrl = "ws://127.0.0.1:47831/rpc"
const loopbackPage = "http://127.0.0.1:5178"
const bearer = "a".repeat(43)
const deviceToken = "b".repeat(43)
const deviceId = `device-${"c".repeat(32)}`

const environment: BrowserPlatformEnvironment = {
  secureContext: true,
  notifications: undefined,
  clipboard: undefined,
  install: { homeScreenOnly: false, installed: () => false, promptable: () => false, prompt: async () => {} },
}

function memoryStorage(): Storage {
  const held = new Map<string, string>()
  return {
    get length() { return held.size },
    clear: () => held.clear(),
    getItem: (key) => held.get(key) ?? null,
    key: (index) => [...held.keys()][index] ?? null,
    removeItem: (key) => { held.delete(key) },
    setItem: (key, value) => { held.set(key, value) },
  }
}

function pairedResult() {
  return {
    token: deviceToken,
    device: { id: deviceId, label: "Web browser 1234", pairedAt: "2026-09-22T12:00:00.000Z", binding: { kind: "client", client: "web" } },
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
})

function draw(storage: Storage, createClient: PairingClientFactory, extra: Partial<Pick<WebAppProps, "rpcUrl" | "pageOrigin" | "memory" | "codeFromUrl" | "clientKind">> = {}) {
  return act(async () => {
    root.render(
      <WebApp
        rpcUrl={extra.rpcUrl ?? rpcUrl}
        pageOrigin={extra.pageOrigin ?? loopbackPage}
        {...(extra.memory ? { memory: extra.memory } : {})}
        {...(extra.codeFromUrl ? { codeFromUrl: extra.codeFromUrl } : {})}
        clientKind={extra.clientKind ?? "web"}
        environment={environment}
        storage={storage}
        createClient={createClient}
        labelSuffix={() => "1234"}
        workspace={({ token, onChangeCredential }) => (
          <main>
            <p>Workspace open with {token === deviceToken ? "the device credential" : "another credential"}</p>
            <button type="button" onClick={onChangeCredential}>Change credential</button>
          </main>
        )}
      />,
    )
  })
}

function text(): string {
  return container.textContent ?? ""
}

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === name)
  if (!found) throw new Error(`No button named ${name}; the screen says: ${text()}`)
  return found
}

async function submitCredential(value: string) {
  const input = container.querySelector<HTMLInputElement>("#daemon-credential")
  if (!input) throw new Error(`No credential field; the screen says: ${text()}`)
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await act(async () => {
    input.form?.requestSubmit()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function useCredentialPath() {
  await act(async () => { button("Paste the daemon credential instead").click() })
}

async function submitCode(value: string) {
  const input = container.querySelector<HTMLInputElement>("#web-code")
  if (!input) throw new Error(`No web code field; the screen says: ${text()}`)
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await act(async () => {
    input.form?.requestSubmit()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function pairingClient(outcome: "pairs" | "refuses"): BearerPairingClient & CodePairingClient {
  return {
    connect: vi.fn(async () => undefined),
    request: vi.fn(async () => {
      if (outcome === "refuses") throw new Error("Daemon authentication failed")
      return pairedResult()
    }),
    disconnect: vi.fn(),
  }
}

describe("WebApp", () => {
  // J26, 2026-09-23: the first screen asks for the code the machine shows;
  // the daemon credential stays one link away.
  it("asks for the machine's web code when this tab holds no session", async () => {
    await draw(memoryStorage(), vi.fn())
    expect(text()).toContain("Connect this browser to")
    expect(text()).toContain("127.0.0.1:47831")
    expect(text()).toContain("HOW THIS TAB IS TRUSTED")
    expect(text()).not.toContain("Workspace open")
    await useCredentialPath()
    expect(text()).toContain("Connect to this daemon")
  })

  // Q5, answered A (docs/plans/s3-2-web-over-tailnet.md section 3.6): a page
  // the daemon served to another machine offers code pairing only, so the
  // daemon's root credential never leaves the machine through it.
  it("offers no way to paste the daemon credential on a page served off loopback", async () => {
    const createClient = vi.fn(() => pairingClient("pairs"))
    await draw(memoryStorage(), createClient, { rpcUrl: "wss://studio.example.ts.net:47831/rpc", pageOrigin: "https://studio.example.ts.net:47831" })
    expect(text()).toContain("Connect this browser to")
    expect(text()).not.toContain("Paste the daemon credential instead")
    expect(container.querySelector("#daemon-credential")).toBeNull()
    // The code still pairs.
    await submitCode("hearth-quiet-ember-42")
    expect(text()).toContain("This browser is paired with studio.example.ts.net:47831")
  })

  it("drops the credential prompt when the page is no longer on loopback", async () => {
    const createClient = vi.fn(() => pairingClient("pairs"))
    await draw(memoryStorage(), createClient)
    await useCredentialPath()
    expect(container.querySelector("#daemon-credential")).not.toBeNull()
    await draw(memoryStorage(), createClient, { pageOrigin: "http://192.168.1.20:5178" })
    expect(container.querySelector("#daemon-credential")).toBeNull()
    expect(text()).toContain("Connect this browser to")
    expect(text()).not.toContain("Paste the daemon credential instead")
    expect(createClient).not.toHaveBeenCalled()
  })

  it.each(["http://127.0.0.1:47831", "http://localhost:5178", "http://[::1]:47831"])("keeps the daemon credential one link away on a loopback page at %s", async (pageOrigin) => {
    const createClient = vi.fn(() => pairingClient("pairs"))
    await draw(memoryStorage(), createClient, { pageOrigin })
    await useCredentialPath()
    await submitCredential(bearer)
    expect(createClient).toHaveBeenCalledWith({ url: rpcUrl, client: "web", bearer })
    expect(text()).toContain("Continue to the session")
  })

  // Q382 A: every page before the session carries the Web v2 bar, with the
  // theme toggle; the workspace keeps the desktop bar.
  it("draws the Web v2 bar with a theme toggle on the connect, limits and credential pages", async () => {
    const banner = () => container.querySelector("header")
    await draw(memoryStorage(), vi.fn(() => pairingClient("pairs")))
    expect(banner()?.textContent).toContain("Domovoi")
    expect(banner()?.textContent).toContain("Connect this browser")
    expect([...banner()!.querySelectorAll("button")].some((b) => /Use (light|dark) theme/.test(b.getAttribute("aria-label") ?? ""))).toBe(true)

    await act(async () => { button("What a browser tab can and cannot do").click() })
    const limitsBar = [...container.querySelectorAll("header")].find((header) => header.offsetParent !== null || !header.closest("[hidden]"))
    expect(limitsBar?.textContent).toContain("What a tab can do")
    await act(async () => { button("Back to pairing").click() })

    await useCredentialPath()
    expect(banner()?.textContent).toContain("Connect this browser")
    expect(text()).toContain("Connect to this daemon")
  })

  it("redeems a typed code with no bearer, says it paired, and opens the session on request", async () => {
    const storage = memoryStorage()
    const client = pairingClient("pairs")
    const createClient = vi.fn(() => client)
    await draw(storage, createClient)
    await submitCode("hearth-quiet-ember-42")
    expect(createClient).toHaveBeenCalledWith({ url: rpcUrl, client: "web" })
    expect(client.request).toHaveBeenCalledWith("device.redeemCode", expect.objectContaining({ code: "hearth-quiet-ember-42", label: "Web browser 1234" }))
    expect(text()).toContain("This browser is paired with 127.0.0.1:47831")
    expect(storage.getItem("domovoi.daemon-session")).toContain(deviceToken)
    await act(async () => { button("Open sessions").click() })
    expect(text()).toContain("Continue to the session")
  })

  // Q196, 2026-09-29: a phone browser handed a web code would store a
  // credential it can never greet with. It keeps nothing and says which code
  // it needs instead of saying it paired.
  it("keeps nothing when a phone browser redeems a web code, and says which code it needs", async () => {
    const storage = memoryStorage()
    await draw(storage, vi.fn(() => pairingClient("pairs")), { clientKind: "phone" })
    await submitCode("hearth-quiet-ember-42")
    expect(text()).toContain("This code is for a web browser")
    expect(text()).toContain("This browser counts as a phone. On 127.0.0.1:47831, show a phone code under Settings, Phone and tablet. The code was used, so in the desktop app on 127.0.0.1:47831, under Machines, revoke Phone browser 1234.")
    expect(text()).not.toContain("This browser is paired with")
    expect(storage.getItem("domovoi.daemon-session")).toBeNull()
  })

  // Q197, 2026-09-29: the prompt names the code this browser greets with.
  it("asks a phone browser for the phone code and a desktop browser for the web code", async () => {
    await draw(memoryStorage(), vi.fn(), { clientKind: "phone" })
    expect(text()).toContain("Type the phone code shown on the machine, in Settings under Phone and tablet.")
    expect(container.querySelector("label[for='web-code']")?.textContent).toBe("Phone code")
    await act(async () => { root.unmount() })
    root = createRoot(container)
    await draw(memoryStorage(), vi.fn(), { clientKind: "tablet" })
    expect(text()).toContain("Type the tablet code shown on the machine, in Settings under Phone and tablet.")
    expect(container.querySelector("label[for='web-code']")?.textContent).toBe("Tablet code")
    await act(async () => { root.unmount() })
    root = createRoot(container)
    await draw(memoryStorage(), vi.fn())
    expect(text()).toContain("Type the web code shown on the machine, in Settings under Phone and tablet.")
    expect(container.querySelector("label[for='web-code']")?.textContent).toBe("Web code")
  })

  it("pairs a phone browser with a phone code", async () => {
    const storage = memoryStorage()
    const phone = pairedResult()
    phone.device.binding.client = "phone"
    const client = { ...pairingClient("pairs"), request: vi.fn(async () => phone) }
    await draw(storage, vi.fn(() => client), { clientKind: "phone" })
    await submitCode("hearth-quiet-ember-42")
    expect(text()).toContain("This browser is paired with 127.0.0.1:47831")
    expect(storage.getItem("domovoi.daemon-session")).toContain(deviceToken)
  })

  it("draws the daemon's uniform refusal and lets the person type again", async () => {
    const { DaemonRpcError } = await import("@/client")
    const { daemonAuthenticationErrorCode } = await import("@getdomovoi/protocol")
    const client = { ...pairingClient("pairs"), request: vi.fn(async () => { throw new DaemonRpcError(daemonAuthenticationErrorCode, "Pairing was refused") }) }
    await draw(memoryStorage(), vi.fn(() => client))
    await submitCode("hearth-quiet-ember-42")
    expect(text()).toContain("That code was refused")
    expect(text()).toContain("It may have expired or been used already.")
    await act(async () => { button("Type a new code").click() })
    expect(text()).toContain("Pair this browser")
  })

  // A daemon ahead of this page is cured by a reload, not by another code, so
  // that is the action it offers. The code was not spent.
  it("offers a reload when the daemon is ahead of this page", async () => {
    const { DaemonRpcError } = await import("@/client")
    const { protocolVersionMismatchErrorCode } = await import("@getdomovoi/protocol")
    const reloadPage = vi.fn()
    const client = { ...pairingClient("pairs"), request: vi.fn(async () => { throw new DaemonRpcError(protocolVersionMismatchErrorCode, "Protocol version mismatch", { daemonProtocolVersion: "9.0.0", clientProtocolVersion: "0.8.0", compatibility: "machine-ahead" }) }) }
    await act(async () => {
      root.render(
        <WebApp
          rpcUrl={rpcUrl}
          pageOrigin={loopbackPage}
          clientKind="web"
          environment={{ ...environment, reloadPage }}
          storage={memoryStorage()}
          createClient={vi.fn(() => client)}
          labelSuffix={() => "1234"}
          workspace={() => <main />}
        />,
      )
    })
    await submitCode("hearth-quiet-ember-42")
    expect(text()).toContain("This page is older than the daemon on 127.0.0.1:47831")
    expect(() => button("Type a new code")).toThrow()
    await act(async () => { button("Reload this page").click() })
    expect(reloadPage).toHaveBeenCalledOnce()
  })

  it("offers no action when the daemon is ahead and the page cannot be reloaded", async () => {
    const { DaemonRpcError } = await import("@/client")
    const { protocolVersionMismatchErrorCode } = await import("@getdomovoi/protocol")
    const client = { ...pairingClient("pairs"), request: vi.fn(async () => { throw new DaemonRpcError(protocolVersionMismatchErrorCode, "Protocol version mismatch", { compatibility: "machine-ahead" }) }) }
    await draw(memoryStorage(), vi.fn(() => client))
    await submitCode("hearth-quiet-ember-42")
    expect(text()).toContain("Reload the page to update it.")
    expect(() => button("Type a new code")).toThrow()
    expect(() => button("Reload this page")).toThrow()
  })

  // An older daemon is not cured by a reload. It checks the version before it
  // spends the code, so the code still works once the daemon is updated.
  it("says the daemon is older and offers the code again when the daemon is behind", async () => {
    const { DaemonRpcError } = await import("@/client")
    const { protocolVersionMismatchErrorCode } = await import("@getdomovoi/protocol")
    const reloadPage = vi.fn()
    const client = { ...pairingClient("pairs"), request: vi.fn(async () => { throw new DaemonRpcError(protocolVersionMismatchErrorCode, "Protocol version mismatch", { daemonProtocolVersion: "0.7.0", clientProtocolVersion: "0.8.0", compatibility: "machine-behind" }) }) }
    await act(async () => {
      root.render(
        <WebApp
          rpcUrl={rpcUrl}
          pageOrigin={loopbackPage}
          clientKind="web"
          environment={{ ...environment, reloadPage }}
          storage={memoryStorage()}
          createClient={vi.fn(() => client)}
          labelSuffix={() => "1234"}
          workspace={() => <main />}
        />,
      )
    })
    await submitCode("hearth-quiet-ember-42")
    expect(text()).toContain("The daemon on 127.0.0.1:47831 is older than this page")
    expect(text()).not.toContain("This page is older")
    expect(() => button("Reload this page")).toThrow()
    await act(async () => { button("Type a new code").click() })
    expect(text()).toContain("Pair this browser")
    expect(reloadPage).not.toHaveBeenCalled()
  })

  it("offers no action when the daemon does not say which side is older", async () => {
    const { DaemonRpcError } = await import("@/client")
    const { protocolVersionMismatchErrorCode } = await import("@getdomovoi/protocol")
    const client = { ...pairingClient("pairs"), request: vi.fn(async () => { throw new DaemonRpcError(protocolVersionMismatchErrorCode, "Protocol version mismatch") }) }
    await act(async () => {
      root.render(
        <WebApp
          rpcUrl={rpcUrl}
          pageOrigin={loopbackPage}
          clientKind="web"
          environment={{ ...environment, reloadPage: vi.fn() }}
          storage={memoryStorage()}
          createClient={vi.fn(() => client)}
          labelSuffix={() => "1234"}
          workspace={() => <main />}
        />,
      )
    })
    await submitCode("hearth-quiet-ember-42")
    expect(text()).toContain("speak different protocol versions")
    expect(() => button("Type a new code")).toThrow()
    expect(() => button("Reload this page")).toThrow()
  })

  // Every other refusal is cured by another code, the daemon's uniform
  // refusal included; the page does not guess why a code was refused.
  it("offers a new code for a device limit and a code of the wrong kind", async () => {
    const { DaemonRpcError } = await import("@/client")
    const { devicePairingLimitErrorCode } = await import("@getdomovoi/protocol")
    const full = { ...pairingClient("pairs"), request: vi.fn(async () => { throw new DaemonRpcError(devicePairingLimitErrorCode, "Device limit reached") }) }
    await draw(memoryStorage(), vi.fn(() => full))
    await submitCode("hearth-quiet-ember-42")
    expect(text()).toContain("has no room for another device")
    await act(async () => { button("Type a new code").click() })
    expect(text()).toContain("Pair this browser")

    await act(async () => { root.unmount() })
    root = createRoot(container)
    await draw(memoryStorage(), vi.fn(() => pairingClient("pairs")), { clientKind: "phone" })
    await submitCode("hearth-quiet-ember-42")
    expect(text()).toContain("This code is for a web browser")
    expect(() => button("Type a new code")).not.toThrow()
  })

  it("says why pairing failed and stays on the prompt", async () => {
    const client = pairingClient("refuses")
    await draw(memoryStorage(), vi.fn(() => client))
    await useCredentialPath()
    await submitCredential(bearer)
    expect(text()).toContain("Daemon authentication failed")
    expect(text()).toContain("Connect to this daemon")
    expect(client.disconnect).toHaveBeenCalled()
  })

  it("says the browser could not be paired when the failure carries no message", async () => {
    const client = { ...pairingClient("pairs"), connect: vi.fn(() => Promise.reject("socket closed")) }
    await draw(memoryStorage(), vi.fn(() => client))
    await useCredentialPath()
    await submitCredential(bearer)
    expect(text()).toContain("This browser could not be paired with the daemon")
  })

  it("states the limits once after pairing and before the session, then opens the session", async () => {
    const storage = memoryStorage()
    const createClient = vi.fn(() => pairingClient("pairs"))
    await draw(storage, createClient)
    await useCredentialPath()
    await submitCredential(bearer)
    expect(createClient).toHaveBeenCalledWith({ url: rpcUrl, client: "web", bearer })
    expect(text()).toContain("Continue to the session")
    expect(text()).not.toContain("Workspace open")

    await act(async () => { button("Continue to the session").click() })
    expect(text()).toContain("Workspace open with the device credential")

    // A second draw in the same tab goes straight to the session: the limits
    // are stated once per tab.
    await act(async () => { root.unmount() })
    root = createRoot(container)
    await draw(storage, createClient)
    expect(text()).toContain("Workspace open with the device credential")
  })

  // Ruled 2026-09-23: the certificate line is a fact about a connection, so
  // it shows only once the daemon answered over a secure one.
  it("states the certificate only after the daemon answered over wss", async () => {
    const { DaemonRpcError } = await import("@/client")
    const { daemonAuthenticationErrorCode } = await import("@getdomovoi/protocol")
    const certificate = "The certificate is the one the browser checked for this name."
    const client = { ...pairingClient("pairs"), request: vi.fn(async () => { throw new DaemonRpcError(daemonAuthenticationErrorCode, "Pairing was refused") }) }
    await draw(memoryStorage(), vi.fn(() => client), { rpcUrl: "wss://mac-mini-m4.tail4c2e.ts.net:47831/rpc" })
    expect(text()).toContain("This tab talks only to the daemon at mac-mini-m4.tail4c2e.ts.net:47831.")
    expect(text()).not.toContain(certificate)
    await submitCode("hearth-quiet-ember-42")
    expect(text()).toContain("That code was refused")
    expect(text()).toContain(certificate)
  })

  it("says nothing about the certificate when the daemon never answered", async () => {
    const { PairingTransportError } = await import("@/browser-pairing-client")
    const client = { ...pairingClient("pairs"), connect: vi.fn(() => Promise.reject(new PairingTransportError("Daemon connection failed"))) }
    await draw(memoryStorage(), vi.fn(() => client), { rpcUrl: "wss://mac-mini-m4.tail4c2e.ts.net:47831/rpc" })
    await submitCode("hearth-quiet-ember-42")
    expect(text()).toContain("did not answer, so pairing is unconfirmed")
    expect(text()).not.toContain("The certificate is the one the browser checked")
  })

  // Once the daemon spent the code, sending it again would only pair another
  // device. A tab that cannot keep the credential, or a reply it cannot read,
  // gets no Try again, and is told to unpair the extra device.
  it("offers no retry when the tab cannot keep the credential the daemon returned", async () => {
    const storage = memoryStorage()
    storage.setItem = () => { throw new Error("blocked") }
    const client = pairingClient("pairs")
    await draw(storage, vi.fn(() => client))
    await submitCode("hearth-quiet-ember-42")
    expect(text()).toContain("This browser blocked session storage, so Domovoi cannot hold a daemon credential for this tab.")
    // Only the machine's own desktop app manages devices, the control is
    // Revoke, and the card names the device it enrolled.
    expect(text()).toContain("The daemon paired this browser as Web browser 1234. In the desktop app on 127.0.0.1:47831, under Machines, revoke Web browser 1234.")
    expect(text()).not.toContain("unpair the extra device")
    expect(text()).not.toContain("did not answer")
    expect(() => button("Try again")).toThrow()
    expect(() => button("Type a new code")).toThrow()
    expect(client.request).toHaveBeenCalledTimes(1)
  })

  it("offers no retry when the daemon's reply cannot be read", async () => {
    const client = { ...pairingClient("pairs"), request: vi.fn(async () => ({ token: "not a credential" })) }
    await draw(memoryStorage(), vi.fn(() => client))
    await submitCode("hearth-quiet-ember-42")
    expect(text()).toContain("answered, but its reply could not be read")
    expect(text()).toContain("It may have paired this browser as Web browser 1234. If it did, in the desktop app on 127.0.0.1:47831, under Machines, revoke Web browser 1234.")
    expect(() => button("Try again")).toThrow()
    expect(() => button("Type a new code")).toThrow()
  })

  // Q366 A: no answer offers Try again, which sends the same code again. If
  // the daemon spent it the first time, its uniform refusal follows.
  it("offers Try again when the daemon did not answer, and resends the same code", async () => {
    const { DaemonRpcError } = await import("@/client")
    const { PairingTransportError } = await import("@/browser-pairing-client")
    const { daemonAuthenticationErrorCode } = await import("@getdomovoi/protocol")
    const request = vi.fn()
      .mockRejectedValueOnce(new PairingTransportError("Daemon connection closed"))
      .mockRejectedValueOnce(new DaemonRpcError(daemonAuthenticationErrorCode, "Pairing was refused"))
    const client = { ...pairingClient("pairs"), request }
    await draw(memoryStorage(), vi.fn(() => client))
    await submitCode("hearth-quiet-ember-42")
    expect(text()).toContain("did not answer, so pairing is unconfirmed")
    expect(() => button("Type a new code")).toThrow()
    await act(async () => {
      button("Try again").click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[1]).toEqual(["device.redeemCode", expect.objectContaining({ code: "hearth-quiet-ember-42" })])
    expect(text()).toContain("That code was refused")
    expect(() => button("Type a new code")).not.toThrow()
  })

  it("names the address as given when it is not a URL", async () => {
    await draw(memoryStorage(), vi.fn(), { rpcUrl: "not a url" })
    expect(text()).toContain("This tab talks only to the daemon at not a url.")
  })

  it("says a reopened tab pairs again when this browser paired before", async () => {
    const memory = memoryStorage()
    memory.setItem("domovoi.paired-before", "1")
    await draw(memoryStorage(), vi.fn(), { memory })
    expect(text()).toContain("Pair this browser again with")
    expect(text()).toContain("This tab has no credential")
  })

  it("treats unreadable memory as a first visit and still pairs when it cannot be written", async () => {
    const memory = { getItem: () => { throw new Error("blocked") }, setItem: () => { throw new Error("blocked") } }
    const storage = memoryStorage()
    await draw(storage, vi.fn(() => pairingClient("pairs")), { memory: memory as unknown as Storage })
    expect(text()).toContain("Connect this browser to")
    await submitCode("hearth-quiet-ember-42")
    expect(text()).toContain("This browser is paired with 127.0.0.1:47831")
    expect(storage.getItem("domovoi.daemon-session")).toContain(deviceToken)
  })

  it("redeems the code the machine's QR put in the address bar", async () => {
    const client = pairingClient("pairs")
    await draw(memoryStorage(), vi.fn(() => client), { codeFromUrl: "hearth-quiet-ember-42" })
    expect(text()).toContain("Filled from the QR on the machine.")
    const input = container.querySelector<HTMLInputElement>("#web-code")!
    expect(input.value).toBe("hearth-quiet-ember-42")
    await act(async () => {
      input.form?.requestSubmit()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(client.request).toHaveBeenCalledWith("device.redeemCode", expect.objectContaining({ code: "hearth-quiet-ember-42" }))
  })

  // Focus follows the page: to the limits heading on open, and back to the
  // link that opened them, not to the document body.
  it("moves focus to the limits heading on open and back to the link on Back", async () => {
    await draw(memoryStorage(), vi.fn(() => pairingClient("pairs")))
    const link = button("What a browser tab can and cannot do")
    await act(async () => { link.click() })
    expect(document.activeElement?.tagName).toBe("H1")
    expect(document.activeElement?.textContent).toBe("What a browser tab can and cannot do")
    await act(async () => { button("Back to pairing").click() })
    expect(document.activeElement).toBe(link)
  })

  // The link that opened the limits goes away when pairing finishes while the
  // limits are open, so focus falls back to the outcome card's link.
  it("returns focus to the outcome card's link when pairing finished while the limits were open", async () => {
    let answer: (value: unknown) => void = () => {}
    const client = { ...pairingClient("pairs"), request: vi.fn(() => new Promise((resolve) => { answer = resolve })) }
    await draw(memoryStorage(), vi.fn(() => client))
    await submitCode("hearth-quiet-ember-42")
    const formLink = button("What a browser tab can and cannot do")
    await act(async () => { formLink.click() })
    await act(async () => {
      answer(pairedResult())
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(formLink.isConnected).toBe(false)
    await act(async () => { button("Back").click() })
    expect(document.activeElement).not.toBe(document.body)
    expect(document.activeElement?.textContent).toBe("What a browser tab can and cannot do")
    expect(document.activeElement?.closest("[role='status']")).not.toBeNull()
  })

  // Opened from the accepted card, the tab is already paired, so the way back
  // is not back to pairing.
  it("labels the way back Back when the limits open from the accepted card", async () => {
    await draw(memoryStorage(), vi.fn(() => pairingClient("pairs")))
    await submitCode("hearth-quiet-ember-42")
    expect(text()).toContain("This browser is paired with")
    await act(async () => { button("What a browser tab can and cannot do").click() })
    expect(() => button("Back to pairing")).toThrow()
    await act(async () => { button("Back").click() })
    expect(text()).toContain("This browser is paired with")
    await act(async () => { button("Open sessions").click() })
    expect(text()).toContain("Workspace open with the device credential")
  })

  // The link on the connect page opens the limits before this tab is paired,
  // and the way back keeps what the person typed.
  it("opens the limits from the connect page before pairing, then goes back with the code kept", async () => {
    const storage = memoryStorage()
    await draw(storage, vi.fn(() => pairingClient("pairs")))
    const input = container.querySelector<HTMLInputElement>("#web-code")!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
      setter?.call(input, "hearth-quiet-ember-42")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await act(async () => { button("What a browser tab can and cannot do").click() })
    expect(container.querySelector("[aria-label='Browser limits']")).not.toBeNull()
    expect(text()).not.toContain("Continue to the session")

    await act(async () => { button("Back to pairing").click() })
    expect(container.querySelector("[aria-label='Browser limits']")).toBeNull()
    expect(container.querySelector<HTMLInputElement>("#web-code")?.value).toBe("hearth-quiet-ember-42")

    // Read once on request, the limits are not stated a second time between
    // pairing and the session.
    await submitCode("hearth-quiet-ember-42")
    await act(async () => { button("Open sessions").click() })
    expect(text()).toContain("Workspace open with the device credential")
  })

  it("opens the limits from a refusal card before pairing", async () => {
    const { DaemonRpcError } = await import("@/client")
    const { daemonAuthenticationErrorCode } = await import("@getdomovoi/protocol")
    const client = { ...pairingClient("pairs"), request: vi.fn(async () => { throw new DaemonRpcError(daemonAuthenticationErrorCode, "Pairing was refused") }) }
    await draw(memoryStorage(), vi.fn(() => client))
    await submitCode("hearth-quiet-ember-42")
    await act(async () => { button("What a browser tab can and cannot do").click() })
    expect(container.querySelector("[aria-label='Browser limits']")).not.toBeNull()
    await act(async () => { button("Back to pairing").click() })
    expect(text()).toContain("That code was refused")
  })

  it("returns to the prompt when the person changes the credential", async () => {
    const storage = memoryStorage()
    await draw(storage, vi.fn(() => pairingClient("pairs")))
    await useCredentialPath()
    await submitCredential(bearer)
    await act(async () => { button("Continue to the session").click() })
    await act(async () => { button("Change credential").click() })
    expect(text()).toContain("Connect this browser to")
    expect(storage.getItem("domovoi.daemon-session")).toBeNull()
  })
})
