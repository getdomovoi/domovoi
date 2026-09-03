import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import type { NotificationPreferenceKey, NotificationPreferences } from "./notification-preferences.js"

const notificationOptions: readonly {
  key: NotificationPreferenceKey
  label: string
  description: string
}[] = [
  { key: "completion", label: "Completions", description: "A session finishes a turn while its window is in the background." },
  { key: "failure", label: "Failures", description: "A turn stops on a provider, tool, or Git failure." },
  { key: "approvalNeeded", label: "Approvals needed", description: "A session waits on an approval decision." },
]

export function NotificationSettings({
  preferences,
  onChange,
}: {
  preferences: NotificationPreferences
  onChange: (preferences: NotificationPreferences) => void
}) {
  return (
    <>
      <h1 className="m-0 text-[17px] font-semibold">Notifications</h1>
      <p className="mt-1.5 max-w-[68ch] text-[12.5px] leading-relaxed text-muted-foreground">
        Domovoi raises desktop notifications from workspace events on this client. The preference stays here and is never sent to the execution machine.
      </p>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Desktop notifications</CardTitle>
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
