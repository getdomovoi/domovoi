import { MoonIcon, SunIcon } from "lucide-react"
import { useState } from "react"

import { colorSchemeQuery, resolveAppearanceTheme, useAppearanceTheme, type WorkspaceTheme } from "./appearance"
import { Button } from "./components/ui/button"
import { DomovoiMark } from "./domovoi-mark"
import { browserWorkspaceUiStorage, loadWorkspaceUiState, saveWorkspaceUiState } from "./workspace-persistence"

type ThemeStorage = Pick<Storage, "getItem" | "setItem">

// The Web v2 bar for the pages a browser tab shows before its session: the
// connect page, the daemon credential prompt and the browser limits (Q382 A).
// Inside the session the web keeps the desktop bar. Its theme toggle keeps the
// choice in the same store the workspace reads, so the session opens in it.
export function WebPageHeader({ label, storage }: {
  label: string
  // Where the choice is kept: the workspace's own store by default, or none.
  storage?: ThemeStorage | null
}) {
  const store = storage === null ? undefined : storage ?? browserWorkspaceUiStorage()
  const [theme, setTheme] = useState<WorkspaceTheme>(() => loadWorkspaceUiState(store).theme)
  useAppearanceTheme(theme)
  const resolved = resolveAppearanceTheme(theme, colorSchemeQuery()?.matches ?? true)

  const toggle = () => {
    const next = resolved === "dark" ? "light" : "dark"
    setTheme(next)
    saveWorkspaceUiState(store, { ...loadWorkspaceUiState(store), theme: next })
  }

  return (
    <header className="flex h-[46px] shrink-0 items-center gap-3 border-b px-3.5">
      <DomovoiMark className="size-[22px] text-primary" />
      <span className="text-[13px] font-semibold tracking-[-0.01em]">Domovoi</span>
      <span aria-hidden className="h-[18px] w-px bg-border" />
      <span className="min-w-0 truncate text-[12px] text-muted-foreground">{label}</span>
      <span className="flex-1" />
      <Button type="button" variant="ghost" size="icon-sm" aria-label={resolved === "dark" ? "Use light theme" : "Use dark theme"} onClick={toggle}>
        {resolved === "dark" ? <MoonIcon className="size-4" /> : <SunIcon className="size-4" />}
      </Button>
    </header>
  )
}
