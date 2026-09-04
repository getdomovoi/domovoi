import { Modal, View } from "react-native"

import { Button } from "./ui/button"
import { Text } from "./ui/text"

// A destructive action on a phone is one mis-tap away from happening, and the
// screen is small enough that the button was under a thumb by accident. This
// asks, and it says what will happen rather than "are you sure".
export function ConfirmSheet({
  open,
  title,
  detail,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  detail: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onCancel}>
      <View className="flex-1 justify-end bg-desk/80">
        <View className="gap-3 rounded-t-xl border-t border-border bg-card p-5 pb-8">
          <Text variant="title">{title}</Text>
          <Text variant="meta">{detail}</Text>
          <Button title={confirmLabel} variant="destructive" onPress={onConfirm} />
          <Button title="Cancel" variant="ghost" onPress={onCancel} />
        </View>
      </View>
    </Modal>
  )
}
