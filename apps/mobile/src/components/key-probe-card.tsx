import { useState } from "react"
import { View } from "react-native"

import { Button } from "./ui/button"
import { Card } from "./ui/card"
import { Text } from "./ui/text"
import type { ProbeReport } from "../lib/device-key"

type ProbeState =
  | { state: "idle" }
  | { state: "running" }
  | { state: "done", report: ProbeReport }
  | { state: "failed", message: string }

// A development-only readout. It answers one question that cannot be answered
// off the device: does this phone hold a P-256 key the app cannot read back,
// and does agreement with it produce the same secret as software.
export function KeyProbeCard() {
  const [probe, setProbe] = useState<ProbeState>({ state: "idle" })

  const run = () => {
    setProbe({ state: "running" })
    void (async () => {
      try {
        const [{ probeDeviceKey }, module] = await Promise.all([
          import("../lib/device-key"),
          import("../../modules/domovoi-device-key"),
        ])
        setProbe({ state: "done", report: await probeDeviceKey(module.default) })
      } catch (cause: unknown) {
        setProbe({ state: "failed", message: cause instanceof Error ? cause.message : "The probe failed" })
      }
    })()
  }

  return (
    <Card className="gap-3">
      <Text variant="label">Key custody probe</Text>
      <Text variant="meta">
        Generates a P-256 key in this device's key store, agrees with it against a software key,
        and requires both shared secrets to match.
      </Text>
      <Button
        title={probe.state === "running" ? "Running" : "Run the probe"}
        variant="primary"
        onPress={run}
      />
      {probe.state === "failed" ? (
        <Text className="text-[12px] font-sans-semibold text-destructive">{probe.message}</Text>
      ) : null}
      {probe.state === "done" ? (
        <View className="gap-1.5">
          <Text variant="meta">Reported custody: {probe.report.securityLevel}</Text>
          {probe.report.steps.map((step) => (
            <View key={step.name} className="gap-0.5">
              <Text className="text-[12px] font-sans-semibold text-foreground">
                {step.ok ? "pass" : "fail"} {step.name}
              </Text>
              <Text variant="meta" className="text-[11px]">{step.detail}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </Card>
  )
}
