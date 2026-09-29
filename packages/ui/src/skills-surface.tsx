import type { ComponentProps } from "react"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs"
import { SkillBrowser } from "./skill-browser"
import { ToolInventoryView } from "./tool-inventory-view"

export type SkillsSurfaceTab = "skills" | "tools"

// Skills and the tools each agent loads are two tabs of one surface (J45).
// The tab lives in the shell, which reads the tool inventory only while its
// tab is open.
export function SkillsSurface({
  tab,
  onTabChange,
  skills,
  tools,
}: {
  tab: SkillsSurfaceTab
  onTabChange: (tab: SkillsSurfaceTab) => void
  skills: ComponentProps<typeof SkillBrowser>
  tools: ComponentProps<typeof ToolInventoryView>
}) {
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => { if (value === "skills" || value === "tools") onTabChange(value) }}
      className="min-h-0 min-w-0 flex-1 gap-0"
    >
      <div className="flex shrink-0 items-center border-b px-6 py-1.5">
        <TabsList variant="line" aria-label="Skills and tools">
          <TabsTrigger value="skills" className="px-2.5">Skills</TabsTrigger>
          <TabsTrigger value="tools" className="px-2.5">Tools</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="skills" className="flex min-h-0 min-w-0">
        <SkillBrowser {...skills} />
      </TabsContent>
      <TabsContent value="tools" className="flex min-h-0 min-w-0">
        <ToolInventoryView {...tools} />
      </TabsContent>
    </Tabs>
  )
}
