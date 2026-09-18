import { useState } from "react"
import { Modal, View } from "react-native"

import { Button } from "./ui/button"
import { Text } from "./ui/text"

// Two controls the desktop design keeps apart and the wiring had collapsed:
// pausing stops at the next turn boundary and nothing is lost; the emergency
// stop kills processes now. On a phone the second is one mis-tap away, so it
// asks a second time and the second question says what it destroys.
export function StopSheet({ open, onOpenStop, onEmergencyStop, onCancel }: {
  open: boolean
  onOpenStop: () => void
  onEmergencyStop: () => void
  onCancel: () => void
}) {
  const [arming, setArming] = useState(false)
  const close = () => { setArming(false); onCancel() }
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={close}>
      <View className="flex-1 justify-end bg-desk/80">
        <View className="gap-3 rounded-t-2xl border-t border-border bg-card p-5 pb-8">
          <Text variant="nav">Stop everything on this machine</Text>
          {arming ? (
            <>
              <Text variant="note" className="text-destructive">
                This kills every running agent and terminal on the machine right now. Anything half-written stays half-written. There is no undo.
              </Text>
              <Button title="Kill everything now" variant="destructive" shape="block" onPress={() => { setArming(false); onEmergencyStop() }} />
              <Button title="Back" variant="ghost" shape="block" onPress={() => setArming(false)} />
            </>
          ) : (
            <>
              <View className="gap-1">
                <Button title="Pause everything" variant="primary" shape="block" onPress={onOpenStop} />
                <Text variant="note">Stops at the next turn boundary. Nothing is killed, and each session can be resumed.</Text>
              </View>
              <View className="gap-1">
                <Button title="Emergency stop" variant="destructive" shape="block" onPress={() => setArming(true)} />
                <Text variant="note">Kills processes now, including terminals. Half-written files stay half-written.</Text>
              </View>
              <Button title="Cancel" variant="ghost" shape="block" onPress={close} />
            </>
          )}
        </View>
      </View>
    </Modal>
  )
}
