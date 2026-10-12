import { useEffect, useState } from "react"
import { DownloadIcon, LockIcon, MessageSquarePlusIcon, MoreHorizontalIcon, PrinterIcon } from "lucide-react"
import type { Artifact } from "@getdomovoi/protocol"

import { Button } from "./components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu"
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip"
import { Chip } from "./chip"
import { cn } from "./lib/utils"
import { previewGrantLabel } from "./preview-grant"
import type { RenderedPreview } from "./preview-renders"

export const PreviewCopy = {
  renderedHeading: "RENDERED THIS SESSION",
  renderedLabel: "Rendered this session",
  addComment: "Add a comment",
  pickElement: "Click an element",
  pickHint: "Click an element in the preview to comment on it.",
  grantNote: "The daemon signs this grant for this document only. While the preview is on screen, a new one is requested before it expires. A page already loaded keeps running without one.",
  safeCopies: "Safe copies remove scripts, forms, and external assets.",
  live: "Live · reloads when the agent renders a new revision",
} as const

// The design's sm, md and lg. lg is the default and fills the stage.
export const previewWidths = [
  { id: "sm", label: "sm", pixels: 390, name: "390 pixel preview" },
  { id: "md", label: "md", pixels: 834, name: "834 pixel preview" },
  { id: "lg", label: "lg", pixels: undefined, name: "Full width preview" },
] as const

export type PreviewWidth = (typeof previewWidths)[number]["id"]

export function previewWidthPixels(width: PreviewWidth): number | undefined {
  return previewWidths.find((candidate) => candidate.id === width)?.pixels
}

export function previewWidthMeta(width: PreviewWidth): string {
  const pixels = previewWidthPixels(width)
  return pixels === undefined ? "full width" : `${pixels}px`
}

export function PreviewWidthToggle({ value, onChange }: { value: PreviewWidth, onChange: (width: PreviewWidth) => void }) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(next) => {
        const width = previewWidths.find((candidate) => candidate.id === next)
        if (width) onChange(width.id)
      }}
      aria-label="Preview device width"
    >
      {previewWidths.map((width) => (
        <ToggleGroupItem key={width.id} value={width.id} className="min-h-11 min-w-11 rounded-full font-machine text-mono-xs" aria-label={width.name}>
          {width.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

// Q379 A: authorization stays automatic, and the chip draws the grant's time
// left from expiresAt (turned into this client's clock when the grant arrived,
// as expiresAtMs). It ticks on its own so the dock does not re-render every
// second.
export function PreviewGrantChip({ expiresAtMs, renewalError }: { expiresAtMs: number | undefined, renewalError: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (expiresAtMs === undefined) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [expiresAtMs])
  if (expiresAtMs === undefined) return null
  const msLeft = expiresAtMs - now
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex rounded-full">
          <Chip size="badge" tone={msLeft > 0 ? "ok" : "warning"} className="min-h-7 px-[10px]">
            <LockIcon aria-hidden="true" className="size-3" />
            {previewGrantLabel(msLeft)}
          </Chip>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[260px]">
        {renewalError ? `${PreviewCopy.grantNote} The last renewal failed: ${renewalError}` : PreviewCopy.grantNote}
      </TooltipContent>
    </Tooltip>
  )
}

export function PreviewAnnotateButton({ active, onToggle, iconOnly = false }: { active: boolean, onToggle: () => void, iconOnly?: boolean }) {
  return (
    <Button
      variant="outline"
      size={iconOnly ? "icon-sm" : "xs"}
      className={cn("min-h-11 rounded-full", iconOnly && "min-w-11", active && "border-primary text-primary")}
      aria-pressed={active}
      aria-label={iconOnly ? PreviewCopy.addComment : undefined}
      onClick={onToggle}
    >
      <MessageSquarePlusIcon data-icon={iconOnly ? undefined : "inline-start"} />
      {iconOnly ? null : active ? PreviewCopy.pickElement : PreviewCopy.addComment}
    </Button>
  )
}

// Q380 A: Print view, Download safe copy, Compare, the filmstrip, the Live
// note and the safe-copies line are shipped features the design does not
// draw. They stay, behind this one control.
export function PreviewOverflowMenu({
  connected,
  pending,
  onPrint,
  onDownload,
  compare,
  thumbnails,
}: {
  connected: boolean
  pending: "print" | "download" | undefined
  onPrint: () => void
  onDownload: () => void
  compare?: { checked: boolean, disabled: boolean, onCheckedChange: (checked: boolean) => void } | undefined
  thumbnails?: { checked: boolean, onCheckedChange: (checked: boolean) => void } | undefined
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="min-h-11 min-w-11 rounded-full text-muted-foreground" aria-label="More preview actions">
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      {/* esc closes the menu only, not the floating sheet around it (see
          PreviewFullscreen). */}
      <DropdownMenuContent align="end" className="w-64" onEscapeKeyDown={(event) => event.stopPropagation()}>
        <DropdownMenuItem disabled={!connected || pending !== undefined} aria-label="Open sanitized print view" onSelect={onPrint}>
          <PrinterIcon />{pending === "print" ? "Preparing" : "Print view"}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!connected || pending !== undefined} aria-label="Download sanitized offline HTML copy" onSelect={onDownload}>
          <DownloadIcon />{pending === "download" ? "Preparing" : "Download safe copy"}
        </DropdownMenuItem>
        <DropdownMenuLabel className="text-micro font-normal text-muted-foreground">{PreviewCopy.safeCopies}</DropdownMenuLabel>
        {compare || thumbnails ? <DropdownMenuSeparator /> : null}
        {compare ? (
          <DropdownMenuCheckboxItem checked={compare.checked} disabled={compare.disabled} onCheckedChange={compare.onCheckedChange}>
            Compare
          </DropdownMenuCheckboxItem>
        ) : null}
        {thumbnails ? (
          <DropdownMenuCheckboxItem checked={thumbnails.checked} onCheckedChange={thumbnails.onCheckedChange}>
            Variant thumbnails
          </DropdownMenuCheckboxItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-micro font-normal text-muted-foreground">{PreviewCopy.live}</DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// The design's segmented variant chips at the foot of the preview.
export function PreviewVariantChips({
  variants,
  selectedArtifactId,
  onSelect,
}: {
  variants: readonly Pick<Artifact, "id" | "title" | "variant">[]
  selectedArtifactId: string | undefined
  onSelect: (artifactId: string) => void
}) {
  return (
    <ToggleGroup
      type="single"
      value={selectedArtifactId ?? ""}
      onValueChange={(next) => { if (next) onSelect(next) }}
      aria-label="Design variants"
      // A group may hold up to 24 variants (performance-budgets.json); the
      // row scrolls rather than clip the later chips in a narrow dock.
      className="max-w-full overflow-x-auto rounded-full bg-accent p-[3px]"
    >
      {variants.map((artifact) => (
        <ToggleGroupItem key={artifact.id} value={artifact.id} className="min-h-11 rounded-full px-3 text-[11.5px] data-[state=on]:bg-background">
          {artifact.variant?.label ?? artifact.title}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

export const previewRenderListPage = 50

// RENDERED THIS SESSION (D20). Without it a preview outside the newest variant
// group could not be opened at all.
export function PreviewRenderedList({
  renders,
  selectedArtifactId,
  onPick,
  className,
}: {
  renders: readonly RenderedPreview[]
  selectedArtifactId: string | undefined
  onPick: (artifactId: string) => void
  className?: string | undefined
}) {
  // A long session can hold thousands of renders (the snapshot does not bound
  // them), so the list draws the newest page and earlier pages on request,
  // always including the render on screen. Every render stays reachable.
  const [shown, setShown] = useState(previewRenderListPage)
  const selectedIndex = selectedArtifactId === undefined
    ? -1
    : renders.findIndex((render) => render.artifactIds.includes(selectedArtifactId))
  const start = Math.max(0, renders.length - shown)
  // What the next page adds: the renders before `start`, less the one on
  // screen, which is drawn already.
  const revealFrom = Math.max(0, start - previewRenderListPage)
  const earlier = start - revealFrom - (selectedIndex >= revealFrom && selectedIndex < start ? 1 : 0)
  // The render on screen, when it is older than the pages drawn, is drawn on
  // its own above them rather than drawing every render in between.
  const drawn = selectedIndex >= 0 && selectedIndex < start
    ? [renders[selectedIndex]!, ...renders.slice(start)]
    : renders.slice(start)
  return (
    <nav aria-label={PreviewCopy.renderedLabel} className={cn("flex flex-col gap-[3px] bg-sidebar px-2 py-[9px]", className)}>
      <div className="px-2.5 pt-[5px] pb-[7px] text-eyebrow tracking-[.13em] text-faint">{PreviewCopy.renderedHeading}</div>
      {earlier > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          className="min-h-11 justify-start px-[11px] font-normal text-muted-foreground"
          onClick={() => setShown(renders.length - start + previewRenderListPage)}
        >
          {earlier === 1 ? "Show 1 earlier render" : `Show ${earlier} earlier renders`}
        </Button>
      ) : null}
      {drawn.map((render) => {
        const selected = selectedArtifactId !== undefined && render.artifactIds.includes(selectedArtifactId)
        return (
          <Button
            key={render.key}
            variant="ghost"
            aria-current={selected ? "true" : undefined}
            className={cn(
              "h-auto min-h-11 w-full flex-col items-start justify-start gap-[3px] rounded-[calc(var(--radius)-3px)] px-[11px] py-[9px] text-left font-normal hover:bg-accent",
              selected && "bg-accent",
            )}
            // Picking the render on screen keeps the variant being viewed.
            onClick={() => { if (!selected) onPick(render.artifactId) }}
          >
            <span className={cn("w-full truncate text-[12px]", selected ? "text-foreground" : "text-strong")}>{render.label}</span>
            <span className="w-full truncate font-machine text-mono-xs text-faint">{render.meta}</span>
          </Button>
        )
      })}
    </nav>
  )
}
