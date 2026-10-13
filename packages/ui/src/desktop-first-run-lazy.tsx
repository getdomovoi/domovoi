import type { DesktopFirstRunDialogProps } from "./desktop-first-run"
import { browserDesktopFirstRunStorage, rememberDesktopFirstRunDismissed } from "./desktop-first-run-persistence"
import { DialogLoading, lazyDialog, useDrawnOnceOpen } from "./lazy-surface"

// First-run setup opens only in the desktop app, on its first launch or from
// Settings, so its code is not part of what a launch loads: the web never
// asks for it, and the desktop loads it when setup opens. It is not fetched
// at idle either, since most launches never open it. Until the code lands a
// full-window frame with the setup's name stands in for it (DialogLoading),
// and closing that frame skips setup exactly as Skip for now does, so a skip
// made while it loads is remembered and holds when the code arrives.
const firstRunDialog = lazyDialog(async () => (await import("./desktop-first-run")).DesktopFirstRunDialog)
const LoadedFirstRunDialog = firstRunDialog.Dialog

export function DesktopFirstRunDialog(props: DesktopFirstRunDialogProps) {
  const drawn = useDrawnOnceOpen(props.open)
  if (!drawn) return null
  return (
    <LoadedFirstRunDialog
      {...props}
      loading={(
        <DialogLoading
          open={props.open}
          onOpenChange={(next) => {
            if (next) return
            rememberDesktopFirstRunDismissed(browserDesktopFirstRunStorage())
            props.onSkip()
          }}
          title="Domovoi setup"
          showCloseButton={false}
          className="flex h-dvh max-h-none max-w-none flex-col gap-4 rounded-none bg-background p-6 sm:max-w-none"
        />
      )}
    />
  )
}
