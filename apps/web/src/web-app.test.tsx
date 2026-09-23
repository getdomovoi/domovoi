// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { BrowserPlatformEnvironment } from "./browser-platform"
import type { PairingClient, PairingClientFactory } from "./daemon-pairing"
import { WebApp } from "./web-app"

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

const rpcUrl = "ws://127.0.0.1:47831/rpc"
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

function draw(storage: Storage, createClient: PairingClientFactory) {
  return act(async () => {
    root.render(
      <WebApp
        rpcUrl={rpcUrl}
        clientKind="web"
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

function pairingClient(outcome: "pairs" | "refuses"): PairingClient {
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
