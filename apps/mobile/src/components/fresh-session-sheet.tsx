import { useState } from "react"
import { Modal, Pressable, TextInput, View } from "react-native"

import type { Project } from "@getdomovoi/protocol"

import type { PhoneRefusal } from "../session-refusal"
import { useTheme } from "../theme/theme-provider"
import { PageScroller } from "./page-scroller"
import { RefusalCard } from "./refusal-card"
import { Button } from "./ui/button"
import { Text } from "./ui/text"

// A start the daemon refused over a repository git filter shows as its
// refusal card in place of the problem line.
export function FreshSessionSheet({ open, projects, projectId, machine, disabledReason, onChooseProject, starting, problem, refusal, onSeeHeldBack, onStart, onClose }: {
  open: boolean
  projects: Project[]
  projectId: string | undefined
  machine: string
  disabledReason: string | undefined
  onChooseProject: (projectId: string) => void
  starting: boolean
  problem: string
  refusal?: PhoneRefusal | undefined
  onSeeHeldBack?: (() => void) | undefined
  onStart: (prompt: string) => void
  onClose: () => void
}) {
  const [prompt, setPrompt] = useState("")
  const [picking, setPicking] = useState(false)
  const project = projects.find((candidate) => candidate.id === projectId)
  const close = () => {
    if (starting) return
    if (picking) setPicking(false)
    else onClose()
  }
  const { palette } = useTheme()
  const usable = prompt.trim().length > 0 && disabledReason === undefined && project !== undefined && project.unavailableReason === undefined
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={close}>
      <Pressable className="flex-1 bg-desk/80" accessibilityLabel="Close" onPress={close} />
      <View className="gap-3 rounded-t-2xl border-t border-border bg-background p-4 pb-8">
        <View className="flex-row items-center gap-2">
          <Text variant="nav" className="flex-1">{picking ? "Choose a project" : "Start a session"}</Text>
          <Button title="Cancel" variant="ghost" onPress={close} className="px-2" disabled={starting} />
        </View>
        {picking ? (
          <PageScroller className="max-h-80">
            {projects.map((candidate) => (
              <Pressable
                key={candidate.id}
                accessibilityRole="radio"
                accessibilityLabel={candidate.name}
                accessibilityState={{ checked: candidate.id === projectId, disabled: candidate.unavailableReason !== undefined }}
                disabled={candidate.unavailableReason !== undefined}
                className="min-h-tap gap-1 border-b border-border px-2 py-3"
                onPress={() => { onChooseProject(candidate.id); setPicking(false) }}
              >
                <Text className={candidate.id === projectId ? "font-mono text-[12px] text-primary" : "font-mono text-[12px] text-strong"}>{candidate.name}</Text>
                <Text variant="machine" className="text-faint">{machine}</Text>
                {candidate.unavailableReason ? <Text variant="note">{candidate.unavailableReason === "folder-missing" ? "folder not found" : "could not check the project folder"}</Text> : null}
              </Pressable>
            ))}
          </PageScroller>
        ) : (
          <>
          {projects.length > 1 ? (
            <Button title={project ? `Project ${project.name}` : "Choose a project"} variant="ghost" shape="block" disabled={starting} onPress={() => setPicking(true)} />
          ) : null}
          {project ? <Text variant="note">Starts in “{project.name}” using the machine provider's default runtime.</Text> : null}
          {disabledReason ? <Text variant="note">{disabledReason}</Text> : null}
          {refusal && onSeeHeldBack
            ? <RefusalCard refusal={refusal} onSeeHeldBack={onSeeHeldBack} />
            : problem ? <Text className="text-[11.5px] text-destructive">{problem}</Text> : null}
          <TextInput
            multiline
            autoFocus
            editable={!starting}
            value={prompt}
            onChangeText={setPrompt}
            placeholder="What should it do?"
            placeholderTextColor={palette.faint}
            selectionColor={palette.primary}
            accessibilityLabel="What to do"
            className="min-h-[88px] rounded-lg border border-border bg-code px-2.5 py-2 font-sans text-[12px] text-foreground"
          />
          <Button
            title="Start"
            variant="primary"
            shape="block"
            disabled={starting || !usable}
            onPress={() => { if (usable) onStart(prompt.trim()) }}
          />
          </>
        )}
      </View>
    </Modal>
  )
}
