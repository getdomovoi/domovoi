import { decodePairingPayload, phoneAndTabletPromise, type PairingPayload } from "@getdomovoi/protocol"
import { CameraView, useCameraPermissions, type PermissionResponse } from "expo-camera"
import * as Clipboard from "expo-clipboard"
import { useCallback, useEffect, useRef, useState, type ComponentType } from "react"
import { Pressable, TextInput, View } from "react-native"

import { gateReach } from "../gate-reach"
import { route } from "../launch-state"
import type { HandheldClient } from "../lib/protocol-facts"
import { redeemPairingCode, type PairedCredential } from "../lib/redeem-pairing-code"
import { PageScroller } from "../components/page-scroller"
import { Button } from "../components/ui/button"
import { Card } from "../components/ui/card"
import { Icon } from "../components/ui/icon"
import { Text } from "../components/ui/text"
import { useTheme } from "../theme/theme-provider"

// Pairing by camera. The QR carries a daemon address and a credential minted
// by `domovoid pair --client phone`; the phone reads it, names the machine and
// asks once before it connects. The token never appears on screen. A phone
// whose camera is refused pastes the same text instead, read the same way.

export type PairScanResult =
  | { ok: true, payload: PairingPayload }
  | { ok: false, reason: string }

export function readPairingScan(text: string): PairScanResult {
  try {
    return { ok: true, payload: decodePairingPayload(text) }
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : "The pairing code could not be read" }
  }
}

// The camera is injected so a test can hand the screen the text a QR would
// carry without a device.
export type PairScanner = ComponentType<{ onScanned: (text: string) => void }>

function CameraScanner({ onScanned }: { onScanned: (text: string) => void }) {
  return (
    <CameraView
      style={{ flex: 1 }}
      facing="back"
      barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
      onBarcodeScanned={(result) => onScanned(result.data)}
    />
  )
}

// The pairing screens are a sheet over the shell: a close control and the
// screen's name, rather than a page heading. Before pairing it cancels; once
// paired there is nothing left to cancel, so it closes.
function NavRow({ label, onPress }: { label: "Cancel" | "Close", onPress: () => void }) {
  return (
    <View className="flex-row items-center gap-2.5 px-4 pb-2.5 pt-1.5">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        className="min-h-tap min-w-tap -ml-3 items-center justify-center active:opacity-70"
      >
        <Icon name="x" tone="muted" />
      </Pressable>
      <Text className="font-sans text-[13px] text-muted-foreground">Pair with a machine</Text>
    </View>
  )
}

// The viewfinder's four corners, drawn over the camera so it says where the
// code goes without covering it.
function Reticle() {
  const corner = "absolute h-[46px] w-[46px] border-primary"
  return (
    <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
      <View className="h-[208px] w-[208px]">
        <View className={`${corner} left-0 top-0 rounded-tl-[20px] border-l-[3px] border-t-[3px]`} />
        <View className={`${corner} right-0 top-0 rounded-tr-[20px] border-r-[3px] border-t-[3px]`} />
        <View className={`${corner} bottom-0 left-0 rounded-bl-[20px] border-b-[3px] border-l-[3px]`} />
        <View className={`${corner} bottom-0 right-0 rounded-br-[20px] border-b-[3px] border-r-[3px]`} />
      </View>
    </View>
  )
}

function machineName(payload: PairingPayload): string {
  if (payload.label) return payload.label
  try { return new URL(payload.url).hostname } catch { return payload.url }
}

type Paired = { machine: string, route: string, deviceId: string | undefined }

// The machine's id for this device, shortened the way the design draws it. The
// token is never shown; this id is not a secret.
function credentialReference(deviceId: string): string {
  const id = deviceId.replace(/^device-/, "")
  return id.length <= 8 ? id : `${id.slice(0, 4)}…${id.slice(-3)}`
}

// Nothing can wake a phone over a tailnet, so the limit is said the moment
// pairing succeeds rather than when a gate is missed. On a tablet the card
// stands alone in the middle of the screen, with its action inside it.
function PairedCard({ paired, device, onDone }: {
  paired: Paired
  device: HandheldClient
  onDone: () => void
}) {
  const tablet = device === "tablet"
  const facts = paired.deviceId
    ? `${paired.route} · credential ${credentialReference(paired.deviceId)}`
    : paired.route
  const card = (
    <Card className={tablet ? "w-full max-w-[520px] gap-4" : "gap-3"}>
      <View className="gap-[5px]">
        <View className="flex-row items-center gap-2.5">
          <View className="h-[7px] w-[7px] rounded-full bg-success" />
          <Text variant="section" className="flex-1">{`Paired with ${paired.machine}`}</Text>
        </View>
        <Text variant="machine" className="pl-[17px] text-faint">{facts}</Text>
      </View>
      <View className="flex-row items-start gap-2.5 border-t border-border pt-3">
        <View className="mt-[7px] h-1.5 w-1.5 rounded-full bg-info" />
        <Text variant="meta" className="flex-1">{gateReach(device)}</Text>
      </View>
      {tablet ? (
        <View className="flex-row">
          <Button title="Open Sessions" variant="primary" onPress={onDone} />
        </View>
      ) : null}
    </Card>
  )
  if (tablet) return <View className="flex-1 items-center justify-center px-6">{card}</View>
  return (
    <View className="flex-1 gap-[14px] px-3 pb-3">
      {card}
      <View className="flex-1" />
      <Button title="Open Sessions" variant="primary" shape="wide" onPress={onDone} />
    </View>
  )
}

export function PairScanScreen({
  permission,
  requestPermission,
  Scanner = CameraScanner,
  onPaired,
  onDone,
  onCancel,
  redeem = redeemPairingCode,
  deviceName = "",
  device,
  mode = "scan",
  bottomInset = 0,
  readClipboard = Clipboard.getStringAsync,
}: {
  permission: PermissionResponse | null
  requestPermission: () => Promise<PermissionResponse>
  Scanner?: PairScanner
  onPaired: (credential: PairedCredential) => void
  // After the paired card, when the person opens Sessions.
  onDone: () => void
  // Injected so a test can spend a code without a daemon.
  redeem?: (payload: PairingPayload, label: string) => Promise<PairedCredential & { deviceId?: string }>
  onCancel: () => void
  // What a host floats over the foot of the screen, so the scroller pads by
  // it and the keyboard can push the paste field into view. app.tsx draws
  // pairing full screen with no tab bar and passes nothing, so it is 0 there.
  bottomInset?: number
  // What the machine's device list will call this phone.
  deviceName?: string
  // Which device this is, so the paired card names it.
  device: HandheldClient
  mode?: "scan" | "type"
  readClipboard?: () => Promise<string>
}) {
  const [read, setRead] = useState<PairScanResult>()
  const [pasted, setPasted] = useState("")
  const { palette } = useTheme()
  const [name, setName] = useState(deviceName)
  const [pairing, setPairing] = useState(false)
  const [refusal, setRefusal] = useState("")
  const [paired, setPaired] = useState<Paired>()
  // A redemption already in flight cannot be recalled, and the code is spent
  // either way. What must not happen is a late success pairing the phone after
  // the person cancelled or left, which would overwrite a pairing they made
  // since. Each attempt carries a number, and only the current one is heard.
  const attempt = useRef(0)
  useEffect(() => () => { attempt.current += 1 }, [])
  // One handler for the camera's lifetime: a camera reports frames on its own
  // schedule, and a new function each render would re-arm it each time.
  const onScanned = useCallback((text: string) => setRead(readPairingScan(text)), [])
  const cameraRefused = permission !== null && !permission.granted && !permission.canAskAgain
  const cameraReady = permission?.granted === true
  const found = read?.ok ? read.payload : undefined

  if (paired) {
    return (
      <View className="flex-1 bg-background">
        <NavRow label="Close" onPress={onDone} />
        <PairedCard paired={paired} device={device} onDone={onDone} />
      </View>
    )
  }

  return (
    <View className="flex-1 bg-background">
      <NavRow label="Cancel" onPress={() => { attempt.current += 1; onCancel() }} />
      <PageScroller contentContainerClassName="grow gap-[14px] px-4" bottomInset={bottomInset} keyboardShouldPersistTaps="handled">
        {found ? (
          <Card className="gap-3">
            <Text variant="label">Machine</Text>
            <Text className="text-[13px]">{machineName(found)}</Text>
            {/* The phone can check the credential's shape, not its scope: a
                daemon's own credential has the same shape and can do anything
                on that machine. The promise is conditional and says so. */}
            <Text variant="label" className="tracking-[0.13em]">
              {device === "tablet" ? "THIS TABLET WILL BE ABLE TO" : "THIS PHONE WILL BE ABLE TO"}
            </Text>
            {/* The card's own list, including the line it does not keep yet,
                read from the protocol so this screen and the machine's card
                cannot come to say different things. A grant wears the success
                dot and a limit the info dot, as the machine's card draws them. */}
            <View className="gap-1.5">
              {phoneAndTabletPromise.map((line) => (
                <View key={line.text} className="flex-row items-start gap-2">
                  <View className={line.tone === "granted" ? "mt-[6px] h-1.5 w-1.5 rounded-full bg-success" : "mt-[6px] h-1.5 w-1.5 rounded-full bg-info"} />
                  <Text className="flex-1 font-sans text-[11.5px] leading-[17px] text-strong">{line.text}</Text>
                </View>
              ))}
            </View>
            <Text variant="note">
              {`That is the scope of a credential the machine minted with domovoid pair --client ${device}; the daemon refuses everything else to it. The ${device} cannot tell that credential from the machine's own, which can do anything on that machine. Either way it stays in this ${device}'s keychain.`}
            </Text>
            <Text variant="label">Name this phone</Text>
            <TextInput
              accessibilityLabel="Phone name"
              value={name}
              onChangeText={setName}
              autoCorrect={false}
              placeholder="iPhone"
              placeholderTextColor={palette.faint}
              selectionColor={palette.primary}
              editable={!pairing}
              className="min-h-tap rounded-md border border-border bg-code px-3 text-[13px] text-foreground"
            />
            {refusal ? <Text className="px-1 font-sans-medium text-[11.5px] text-destructive">{refusal}</Text> : null}
            <Button
              title={pairing ? "Pairing…" : "Pair with this machine"}
              variant="primary"
              shape="block"
              disabled={pairing}
              onPress={() => {
                if (pairing) return
                setPairing(true)
                setRefusal("")
                attempt.current += 1
                const mine = attempt.current
                redeem(found, name).then(
                  (result) => {
                    if (attempt.current !== mine) return
                    const { deviceId, ...credential } = result
                    setPaired({ machine: machineName(found), route: route(found.url).kind, deviceId })
                    onPaired(credential)
                  },
                  (cause: unknown) => {
                    if (attempt.current !== mine) return
                    setPairing(false)
                    setRefusal(cause instanceof Error ? cause.message : "Pairing did not finish.")
                  },
                )
              }}
            />
            <Button title="Scan again" variant="ghost" shape="block" disabled={pairing} onPress={() => { attempt.current += 1; setRead(undefined); setPasted(""); setRefusal("") }} />
          </Card>
        ) : mode === "type" ? null : cameraReady && !cameraRefused ? (
          <View className="min-h-[300px] flex-1 overflow-hidden rounded-[20px] bg-code">
            <Scanner onScanned={onScanned} />
            <Reticle />
            <View pointerEvents="none" className="absolute inset-x-[18px] bottom-[18px]">
              <Text className="text-center font-sans text-[12.5px] leading-[19px] text-muted-foreground">
                Point at the pairing code that domovoid pair prints on the machine.
              </Text>
            </View>
          </View>
        ) : cameraRefused ? (
          <Card className="gap-2">
            <Text variant="label">Camera refused</Text>
            <Text variant="note">This phone has refused the camera to Domovoi. Allow it in the phone's settings, or paste the pairing code below.</Text>
          </Card>
        ) : (
          <Card className="gap-2">
            <Text variant="note">Domovoi needs the camera to read the pairing code on the machine's screen.</Text>
            <Button title="Allow the camera" variant="primary" shape="block" onPress={() => void requestPermission()} />
          </Card>
        )}
        {read && !read.ok ? (
          <Text className="px-1 font-sans-medium text-[11.5px] text-destructive">{read.reason}</Text>
        ) : null}
        {found ? null : (
          <View className="gap-[9px] rounded-[16px] border border-border px-[15px] py-[13px]">
            <Text className="font-sans text-[12.5px] text-strong">Or type the code</Text>
            <View className="flex-row items-center gap-2">
              <TextInput
                accessibilityLabel="Pairing code"
                value={pasted}
                onChangeText={(text) => {
                  setPasted(text)
                  setRead(text.trim() ? readPairingScan(text) : undefined)
                }}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="domovoi-pair:1:…"
                placeholderTextColor={palette.faint}
                selectionColor={palette.primary}
                className="min-h-tap flex-1 rounded-[14px] bg-accent px-3.5 font-mono text-[11px] text-foreground"
              />
              <Button
                title="Paste"
                variant="quiet"
                onPress={() => void readClipboard().then((text) => {
                  setPasted(text)
                  setRead(text.trim() ? readPairingScan(text) : undefined)
                })}
              />
            </View>
          </View>
        )}
      </PageScroller>
    </View>
  )
}

export function usePairCameraPermission() {
  return useCameraPermissions()
}
