import { BellOffIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldContent, FieldDescription, FieldLabel, FieldTitle } from "@/components/ui/field"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import type { NotificationPreferenceKey, NotificationPreferences } from "./notification-preferences.js"
import type {
  WorkspaceClientCapabilities,
  WorkspaceInstallState,
  WorkspaceNotificationDelivery,
} from "./workspace-platform.js"

const notificationOptions: readonly {
  key: NotificationPreferenceKey
  label: string
  description: string
}[] = [
  { key: "completion", label: "Completions", description: "A session finishes a turn while its window is in the background." },
  { key: "failure", label: "Failures", description: "A turn stops on a provider, tool, or Git failure." },
  { key: "approvalNeeded", label: "Approvals needed", description: "A session waits on an approval decision." },
]

function deliveryDescription(delivery: WorkspaceNotificationDelivery): string {
  if (delivery.status === "ready") return "This browser delivers Domovoi notifications for this origin."
  if (delivery.status === "askable") {
    return "This browser has not been asked yet, so nothing is raised until you allow it."
  }
  return delivery.message
}

function installDescription(install: WorkspaceInstallState): string {
  if (install.status === "installed") return "Domovoi is installed on this device and runs in its own window."
  if (install.status === "installable") {
    return "Domovoi runs in a browser tab. Installing it gives a standalone window on the same daemon connection."
  }
  return install.message
}

export function NotificationSettings({
  preferences,
  onChange,
  client,
}: {
  preferences: NotificationPreferences
  onChange: (preferences: NotificationPreferences) => void
  client?: WorkspaceClientCapabilities
}) {
  const refused = client?.delivery.status === "refused"

  return (
    <>
      <h1 className="m-0 text-[17px] font-semibold">Notifications</h1>
      <p className="mt-1.5 max-w-[68ch] text-[12.5px] leading-relaxed text-muted-foreground">
        {client
          ? "This browser raises notifications from workspace events while a Domovoi tab is open. The preference stays here and is never sent to the execution machine."
          : "Domovoi raises desktop notifications from workspace events on this client. The preference stays here and is never sent to the execution machine."}
      </p>

      {client ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>This client</CardTitle>
            <CardDescription>What this browser can do decides whether the kinds below are ever raised.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-0">
            <Field orientation="horizontal" className="py-3">
              <FieldContent>
                <FieldTitle>Delivery</FieldTitle>
                <FieldDescription>{deliveryDescription(client.delivery)}</FieldDescription>
              </FieldContent>
              {client.delivery.status === "askable" ? (
                <Button variant="outline" size="sm" onClick={client.onRequestDelivery}>
                  Allow notifications
                </Button>
              ) : null}
            </Field>
            <Separator />
            <Field orientation="horizontal" className="py-3">
              <FieldContent>
                <FieldTitle>Installation</FieldTitle>
                <FieldDescription>{installDescription(client.install)}</FieldDescription>
              </FieldContent>
              {client.install.status === "installable" ? (
                <Button variant="outline" size="sm" onClick={client.onInstall}>
                  Install Domovoi
                </Button>
              ) : null}
            </Field>
          </CardContent>
        </Card>
      ) : null}

      {refused ? (
        <Alert variant="destructive" className="mt-6">
          <BellOffIcon />
          <AlertTitle>This browser will not raise notifications</AlertTitle>
          <AlertDescription>
            The kinds below are held for a client that can raise them, and nothing reaches you here until this
            browser can.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{client ? "Browser notifications" : "Desktop notifications"}</CardTitle>
          <CardDescription>Each kind is raised once per event, and never carries command text or file contents.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-0">
          {notificationOptions.map((option, index) => (
            <div key={option.key}>
              {index > 0 ? <Separator /> : null}
              <Field orientation="horizontal" className="py-3">
                <FieldContent>
                  <FieldLabel htmlFor={`notification-${option.key}`}>{option.label}</FieldLabel>
                  <FieldDescription>{option.description}</FieldDescription>
                </FieldContent>
                <Switch
                  id={`notification-${option.key}`}
                  aria-label={option.label}
                  checked={preferences[option.key]}
                  disabled={refused}
                  onCheckedChange={(checked: boolean) => {
                    onChange({ ...preferences, [option.key]: checked })
                  }}
                />
              </Field>
            </div>
          ))}
        </CardContent>
      </Card>
    </>
  )
}
