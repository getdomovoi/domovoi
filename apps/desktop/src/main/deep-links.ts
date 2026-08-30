export type DesktopDeepLink = {
  kind: "session"
  sessionId: string
}

const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u
const maximumDeepLinkLength = 512

export function parseDomovoiDeepLink(value: unknown): DesktopDeepLink | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumDeepLinkLength) return null
  const raw = /^domovoi:\/\/session\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/u.exec(value)
  if (!raw?.[1]) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (
    url.protocol !== "domovoi:"
    || url.hostname !== "session"
    || url.username
    || url.password
    || url.port
    || url.search
    || url.hash
    || !url.pathname.startsWith("/")
  ) return null
  const sessionId = raw[1]
  if (!sessionIdPattern.test(sessionId)) return null
  return { kind: "session", sessionId }
}

export function deepLinksFromArgv(argv: readonly string[]): DesktopDeepLink[] {
  const links: DesktopDeepLink[] = []
  for (const argument of argv.slice(0, 64)) {
    const link = parseDomovoiDeepLink(argument)
    if (link) links.push(link)
  }
  return links
}

type DeepLinkSink = (link: DesktopDeepLink) => void

export class DesktopDeepLinkQueue {
  readonly #maximumPending: number
  readonly #pending: DesktopDeepLink[] = []
  #sink: DeepLinkSink | null = null

  constructor(maximumPending = 32) {
    if (!Number.isInteger(maximumPending) || maximumPending < 1 || maximumPending > 128) {
      throw new Error("Invalid deep-link queue bound")
    }
    this.#maximumPending = maximumPending
  }

  enqueue(link: DesktopDeepLink): void {
    if (this.#sink) {
      this.#sink(link)
      return
    }
    if (this.#pending.some((candidate) =>
      candidate.kind === link.kind && candidate.sessionId === link.sessionId
    )) return
    if (this.#pending.length === this.#maximumPending) this.#pending.shift()
    this.#pending.push(link)
  }

  ready(sink: DeepLinkSink): void {
    this.#sink = sink
    const pending = this.#pending.splice(0)
    for (const link of pending) sink(link)
  }

  pause(sink?: DeepLinkSink): void {
    if (!sink || this.#sink === sink) this.#sink = null
  }
}
