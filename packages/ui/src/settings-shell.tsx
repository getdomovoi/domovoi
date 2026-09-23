import type { ApprovalRule, ProviderRuntime, UpdateStatus } from "@getdomovoi/protocol"
import { ExternalLinkIcon } from "lucide-react"
import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { AppearanceSettings, ExternalEditorSettings, ProviderSettings, type ProviderSecretStatus } from "./provider-settings.js"
import type { WorkspaceTheme } from "./appearance.js"
import type { DesktopExternalEditor, WorkspaceWindowDecoration } from "./desktop-platform.js"
import { NotificationSettings } from "./notification-settings.js"
import type { NotificationPreferences } from "./notification-preferences.js"
import type { WorkspaceClientCapabilities } from "./workspace-platform.js"
import { PermissionRuleSettings } from "./permission-settings.js"


type DesktopCapability = {
  externalEditor: DesktopExternalEditor
  onExternalEditorChange: (editor: DesktopExternalEditor) => void
  windowDecoration: WorkspaceWindowDecoration
  activeWindowDecoration: WorkspaceWindowDecoration
  onWindowDecorationChange: (decoration: WorkspaceWindowDecoration) => void
}

export type LocalDaemonDescription = {
  title: string
  detail: string
}

// About this build (J10, 2026-09-23). The first release is unsigned and does
// not update itself, and Settings says so in one line. scripts/unsigned-build.mjs
// fails the release invariants the day a signing build runs on an automatic
// trigger while this line is still here, so the copy moves with the fact.
export const releasePageUrl = "https://github.com/getdomovoi/domovoi/releases"

export type AboutBuild = {
  version: string
  onUpdateStatus: () => Promise<UpdateStatus>
  // The desktop opens the release page in the person's browser; a browser
  // tab links it directly.
  onOpenReleasePage?: (() => Promise<boolean>) | undefined
}

function AboutBuildSection({ about }: { about: AboutBuild }) {
  const [commit, setCommit] = useState<string | undefined>(undefined)
  useEffect(() => {
    let active = true
    about.onUpdateStatus().then(
      (status) => { if (active) setCommit(status.currentSourceCommit?.slice(0, 7)) },
      () => { if (active) setCommit(undefined) },
    )
    return () => { active = false }
  }, [about])
  return (
    <section aria-labelledby="settings-about" className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="settings-about" className="m-0 text-[13px] font-medium">About this build</h2>
        <span className="font-machine text-[11px] text-muted-foreground">{commit ? `domovoid ${about.version} · ${commit}` : `domovoid ${about.version}`}</span>
        <span className="flex-1" />
        <span className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
          <span aria-hidden className="size-[7px] rounded-full bg-faint" />
          Not signed
        </span>
      </div>
      <p className="m-0 text-[12px] leading-[1.55] text-muted-foreground">This build is not signed and does not update itself. Get new versions from the release page.</p>
      {about.onOpenReleasePage ? (
        <Button variant="outline" size="sm" className="self-start" onClick={() => void about.onOpenReleasePage?.()}>
          Release page
          <ExternalLinkIcon data-icon="inline-end" />
        </Button>
      ) : (
        <a href={releasePageUrl} target="_blank" rel="noopener" className="inline-flex items-center gap-1.5 self-start text-[12px] text-primary underline-offset-2 hover:underline">
          Release page
          <ExternalLinkIcon className="size-3.5" />
        </a>
      )}
    </section>
  )
}

export type SettingsShellProps = {
  providers: readonly ProviderRuntime[]
  about?: AboutBuild | undefined
  secrets: readonly ProviderSecretStatus[]
  localDaemon?: LocalDaemonDescription
  approvalRules: readonly ApprovalRule[]
  notifications: NotificationPreferences
  onNotificationsChange: (preferences: NotificationPreferences) => void
  clientCapabilities?: WorkspaceClientCapabilities
  onOpenFleet: () => void
  onOpenSkills: () => void
  onOpenAudit: () => void
  onResetFirstRun?: () => void
  theme: WorkspaceTheme
  readOnly?: boolean
  onThemeChange: (theme: WorkspaceTheme) => void
} & (DesktopCapability | {
  externalEditor?: undefined
  onExternalEditorChange?: undefined
  windowDecoration?: undefined
  activeWindowDecoration?: undefined
  onWindowDecorationChange?: undefined
})

export function SettingsShell({
  providers,
  secrets,
  about,
  localDaemon,
  approvalRules,
  notifications,
  clientCapabilities,
  externalEditor,
  windowDecoration,
  activeWindowDecoration,
  theme,
  readOnly = false,
  onNotificationsChange,
  onOpenFleet,
  onOpenSkills,
  onOpenAudit,
  onResetFirstRun,
  onExternalEditorChange,
  onWindowDecorationChange,
  onThemeChange,
}: SettingsShellProps) {
  const editorCapability = externalEditor !== undefined && onExternalEditorChange !== undefined
    ? { editor: externalEditor, onChange: onExternalEditorChange }
    : undefined
  const decorationCapability = windowDecoration !== undefined
    && activeWindowDecoration !== undefined
    && onWindowDecorationChange !== undefined
    ? { decoration: windowDecoration, active: activeWindowDecoration, onChange: onWindowDecorationChange }
    : undefined

  return (
    <ScrollArea className="min-h-0 min-w-0 flex-1">
      <main className="mx-auto flex w-full max-w-[760px] flex-col gap-[26px] px-4 py-5 sm:px-6 sm:py-[30px]">
        <header className="flex flex-col gap-1.5">
          <h1 className="m-0 text-[19px] font-semibold tracking-[-0.01em]">Settings</h1>
          <p className="m-0 text-[12.5px] text-muted-foreground">
            This machine holds its own settings. Nothing here is synced anywhere unless the row says so.
          </p>
        </header>

        <fieldset disabled={readOnly} className="contents">
          <section aria-label="Providers and tokens">
            <ProviderSettings providers={providers} secrets={secrets} {...(localDaemon ? { localDaemon } : {})} />
          </section>

          {about ? <AboutBuildSection about={about} /> : null}

          <section aria-label="Notifications">
            <NotificationSettings
              preferences={notifications}
              onChange={onNotificationsChange}
              {...(clientCapabilities ? { client: clientCapabilities } : {})}
            />
          </section>

          <section id="permissions-settings" aria-label="Permissions and rules">
            <PermissionRuleSettings rules={approvalRules} />
          </section>

          {editorCapability ? (
            <section aria-label="External editor">
              <ExternalEditorSettings editor={editorCapability.editor} onEditorChange={editorCapability.onChange} />
            </section>
          ) : null}
        </fieldset>

        <section className="overflow-hidden rounded-lg border bg-card" aria-labelledby="settings-elsewhere">
          <div className="border-b px-[15px] py-[13px]">
            <h2 id="settings-elsewhere" className="m-0 text-[13px] font-medium">Elsewhere</h2>
            <p className="mt-1 text-[11.5px] text-muted-foreground">These live on their own screens.</p>
          </div>
          <div className="flex flex-col">
            <Button variant="ghost" className="h-auto justify-start rounded-none px-[15px] py-3 text-left" onClick={onOpenFleet}>
              <span className="flex flex-col items-start">
                <span>Machines and daemons</span>
                <span className="text-[11px] font-normal text-muted-foreground">Transports, agents installed, and what each one is running.</span>
              </span>
            </Button>
            <Button variant="ghost" className="h-auto justify-start rounded-none border-t px-[15px] py-3 text-left" onClick={onOpenSkills}>
              <span className="flex flex-col items-start">
                <span>Skills</span>
                <span className="text-[11px] font-normal text-muted-foreground">Install sources, signing, and which skills a machine may run.</span>
              </span>
            </Button>
            <Button variant="ghost" className="h-auto justify-start rounded-none border-t px-[15px] py-3 text-left" onClick={onOpenAudit}>
              <span className="flex flex-col items-start">
                <span>Audit log</span>
                <span className="text-[11px] font-normal text-muted-foreground">Who decided what, on which verified device, and what happened next.</span>
              </span>
            </Button>
            {onResetFirstRun ? (
              <Button variant="ghost" className="h-auto justify-start rounded-none border-t px-[15px] py-3 text-left" onClick={onResetFirstRun}>
                First-run setup
              </Button>
            ) : null}
          </div>
        </section>

        <fieldset disabled={readOnly} className="contents">
          <section aria-label="Appearance">
            <AppearanceSettings
              theme={theme}
              onThemeChange={onThemeChange}
              {...(decorationCapability ? {
                windowDecoration: decorationCapability.decoration,
                activeWindowDecoration: decorationCapability.active,
                onWindowDecorationChange: decorationCapability.onChange,
              } : {})}
            />
          </section>
        </fieldset>
      </main>
    </ScrollArea>
  )
}
