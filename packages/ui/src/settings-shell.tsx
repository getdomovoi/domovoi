import type { ApprovalRule, ProviderRuntime } from "@getdomovoi/protocol"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { AppearanceSettings, ExternalEditorSettings, ProviderSettings, type ProviderSecretStatus } from "./provider-settings.js"
import type { WorkspaceTheme } from "./appearance.js"
import type { DesktopExternalEditor, WorkspaceWindowDecoration } from "./desktop-platform.js"
import { NotificationSettings } from "./notification-settings.js"
import type { NotificationPreferences } from "./notification-preferences.js"
import { PermissionRuleSettings } from "./permission-settings.js"

export type SettingsPane = "providers" | "appearance" | "permissions" | "external-editor" | "notifications"

type DesktopCapability = {
  externalEditor: DesktopExternalEditor
  onExternalEditorChange: (editor: DesktopExternalEditor) => void
  windowDecoration: WorkspaceWindowDecoration
  activeWindowDecoration: WorkspaceWindowDecoration
  onWindowDecorationChange: (decoration: WorkspaceWindowDecoration) => void
}

export type SettingsShellProps = {
  providers: readonly ProviderRuntime[]
  secrets: readonly ProviderSecretStatus[]
  approvalRules: readonly ApprovalRule[]
  notifications: NotificationPreferences
  onNotificationsChange: (preferences: NotificationPreferences) => void
  onOpenFleet: () => void
  onOpenSkills: () => void
  onOpenAudit: () => void
  onResetFirstRun?: () => void
  theme: WorkspaceTheme
  onThemeChange: (theme: WorkspaceTheme) => void
} & (DesktopCapability | {
  externalEditor?: undefined
  onExternalEditorChange?: undefined
  windowDecoration?: undefined
  activeWindowDecoration?: undefined
  onWindowDecorationChange?: undefined
})

const paneLabels: Record<SettingsPane, string> = {
  providers: "Providers",
  appearance: "Appearance & window",
  permissions: "Permissions & rules",
  "external-editor": "External editor",
  notifications: "Notifications",
}

export function SettingsShell({
  providers,
  secrets,
  approvalRules,
  notifications,
  externalEditor,
  windowDecoration,
  activeWindowDecoration,
  theme,
  onNotificationsChange,
  onOpenFleet,
  onOpenSkills,
  onOpenAudit,
  onResetFirstRun,
  onExternalEditorChange,
  onWindowDecorationChange,
  onThemeChange,
}: SettingsShellProps) {
  const [pane, setPane] = useState<SettingsPane>("providers")
  const editorCapability = externalEditor !== undefined && onExternalEditorChange !== undefined
    ? { editor: externalEditor, onChange: onExternalEditorChange }
    : undefined
  const decorationCapability = windowDecoration !== undefined
    && activeWindowDecoration !== undefined
    && onWindowDecorationChange !== undefined
    ? { decoration: windowDecoration, active: activeWindowDecoration, onChange: onWindowDecorationChange }
    : undefined
  const activePane = pane === "external-editor" && !editorCapability ? "providers" : pane
  const panes: readonly SettingsPane[] = editorCapability
    ? ["providers", "appearance", "permissions", "external-editor", "notifications"]
    : ["providers", "appearance", "permissions", "notifications"]

  const destinations = (
    <>
      <Button variant="ghost" className="justify-start" onClick={onOpenFleet}>Fleet &amp; machines</Button>
      <Button variant="ghost" className="justify-start" onClick={onOpenSkills}>Skills</Button>
      {panes.map((entry) => (
        <Button
          key={entry}
          variant={activePane === entry ? "secondary" : "ghost"}
          className="justify-start"
          aria-current={activePane === entry ? "page" : undefined}
          onClick={() => setPane(entry)}
        >
          {paneLabels[entry]}
        </Button>
      ))}
      <Button variant="ghost" className="justify-start" onClick={onOpenAudit}>Audit log</Button>
      {onResetFirstRun ? <Button variant="ghost" className="justify-start" onClick={onResetFirstRun}>First-run setup</Button> : null}
    </>
  )

  return (
    <div className="flex min-h-0 flex-1">
      <nav aria-label="Settings" className="hidden w-[236px] shrink-0 flex-col border-r bg-sidebar p-2.5 sm:flex">
        <div className="px-2 pb-3.5 pt-1 text-base font-semibold">Settings</div>
        {destinations}
      </nav>

      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <main className="mx-auto w-full max-w-[780px] px-4 py-5 sm:px-8 sm:py-7">
          <nav aria-label="Settings sections" className="mb-3 -ml-2 flex flex-wrap items-center gap-1 sm:hidden">
            {destinations}
          </nav>

          {activePane === "appearance" ? (
            <AppearanceSettings
              theme={theme}
              onThemeChange={onThemeChange}
              {...(decorationCapability ? {
                windowDecoration: decorationCapability.decoration,
                activeWindowDecoration: decorationCapability.active,
                onWindowDecorationChange: decorationCapability.onChange,
              } : {})}
            />
          ) : activePane === "permissions" ? (
            <PermissionRuleSettings rules={approvalRules} />
          ) : activePane === "notifications" ? (
            <NotificationSettings preferences={notifications} onChange={onNotificationsChange} />
          ) : activePane === "external-editor" && editorCapability ? (
            <ExternalEditorSettings editor={editorCapability.editor} onEditorChange={editorCapability.onChange} />
          ) : (
            <ProviderSettings providers={providers} secrets={secrets} />
          )}
        </main>
      </ScrollArea>
    </div>
  )
}
