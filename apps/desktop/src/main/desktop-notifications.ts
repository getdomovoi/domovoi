export type DesktopNotificationKind = "completion" | "failure" | "approval-needed"

type DesktopNotificationTarget = {
  id: string
  kind: DesktopNotificationKind
  sessionId: string
}

export type NativeNotificationOptions = {
  title: string
  body: string
}

export type NativeNotificationHandle = {
  once(event: "click" | "failed", listener: () => void): void
  show(): void
}

export type NativeNotificationAdapter = {
  isSupported(): boolean
  create(options: NativeNotificationOptions): NativeNotificationHandle
}

export const desktopNotificationCopy: Record<DesktopNotificationKind, NativeNotificationOptions> = {
  completion: {
    title: "Domovoi finished",
    body: "Agent work completed. Open Domovoi to review it.",
  },
  failure: {
    title: "Domovoi needs attention",
    body: "Agent work failed. Open Domovoi to review recovery options.",
  },
  "approval-needed": {
    title: "Approval needed",
    body: "Agent work is waiting for your decision in Domovoi.",
  },
}

function notificationTarget(input: unknown): DesktopNotificationTarget | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null
  const record = input as Record<string, unknown>
  if (Object.keys(record).sort().join(",") !== "id,kind,sessionId") return null
  if (record.kind !== "completion" && record.kind !== "failure" && record.kind !== "approval-needed") return null
  if (typeof record.id !== "string" || typeof record.sessionId !== "string") return null
  const expectedId = new RegExp(`^desktop-${record.kind}-[a-f0-9]{16}$`, "u")
  if (!expectedId.test(record.id)) return null
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(record.sessionId)) return null
  return { id: record.id, kind: record.kind, sessionId: record.sessionId }
}

export class DesktopNotificationController {
  readonly #seen = new Set<string>()

  constructor(private readonly adapter: NativeNotificationAdapter) {}

  notify(input: unknown, activate: (sessionId: string) => void): boolean {
    const target = notificationTarget(input)
    if (!target || this.#seen.has(target.id)) return false
    try {
      if (!this.adapter.isSupported()) return false
      this.#seen.add(target.id)
      const notification = this.adapter.create(desktopNotificationCopy[target.kind])
      notification.once("click", () => {
        try {
          activate(target.sessionId)
        } catch {
          // Window teardown and OS notification delivery can race safely.
        }
      })
      notification.once("failed", () => {})
      notification.show()
      return true
    } catch {
      return false
    }
  }
}
