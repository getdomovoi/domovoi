import { Modal, Pressable, ScrollView, View } from "react-native"

import { cn } from "../lib/cn"
import type { SkillPickerRow } from "../turn-skills"
import { Button } from "./ui/button"
import { Text } from "./ui/text"

export function SkillSheet({
  open,
  rows,
  // Undefined means the person has not chosen, so the project's own defaults
  // stand. It is a different request from choosing nothing, and the sheet has
  // to let them say either one.
  chosen,
  loading,
  problem,
  onToggle,
  onUseDefault,
  onClose,
}: {
  open: boolean
  rows: SkillPickerRow[]
  chosen: boolean
  loading: boolean
  problem: string
  onToggle: (skillId: string) => void
  onUseDefault: () => void
  onClose: () => void
}) {
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <View className="flex-1 justify-end bg-desk/80">
        <View className="max-h-[80%] gap-3 rounded-t-2xl border-t border-border bg-card p-5 pb-8">
          <View className="flex-row items-center gap-2">
            <Text variant="title" className="flex-1">Skills for this turn</Text>
            <Button title="Done" variant="ghost" onPress={onClose} className="px-2" />
          </View>

          {problem ? <Text className="text-[12px] text-destructive">{problem}</Text> : null}

          <Text variant="meta" className="text-[11px]">
            {chosen
              ? "Only the skills ticked here run for the next message."
              : "The project's own skills run unless something is ticked here."}
          </Text>

          {loading ? <Text variant="meta">Asking the daemon for the catalog.</Text> : null}
          {!loading && rows.length === 0 && !problem
            ? (
              <Text variant="meta">
                No skills are enabled for this project, so there is nothing to pick.
              </Text>
            )
            : null}

          <ScrollView contentContainerClassName="gap-1.5">
            {rows.map((row) => (
              <Pressable
                key={row.id}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: row.selected }}
                accessibilityLabel={row.name}
                onPress={() => onToggle(row.id)}
                className="min-h-tap flex-row items-center gap-3 rounded-2xl border border-border bg-background px-3 py-2.5 active:opacity-70"
              >
                <View className={cn(
                  "h-[18px] w-[18px] items-center justify-center rounded-xl border",
                  row.selected ? "border-primary bg-primary" : "border-border",
                )}>
                  {row.selected
                    ? <Text className="text-[10px] text-primary-foreground">✓</Text>
                    : null}
                </View>
                <View className="flex-1 gap-0.5">
                  <Text variant="machine" className="text-[11px] text-foreground">{row.name}</Text>
                  {row.description
                    ? <Text variant="meta" className="text-[11px]" numberOfLines={2}>{row.description}</Text>
                    : null}
                </View>
              </Pressable>
            ))}
          </ScrollView>

          {chosen
            ? <Button title="Use the project default" variant="outline" onPress={onUseDefault} />
            : null}
        </View>
      </View>
    </Modal>
  )
}
