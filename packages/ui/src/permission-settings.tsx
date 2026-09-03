import type { ApprovalRule } from "@getdomovoi/protocol"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"

type InactiveRule = Extract<ApprovalRule, { status: "inactive" }>

const inactiveReasonCopy: Record<InactiveRule["inactiveReason"], string> = {
  "legacy-text-only": "This approval matched command text only. It was deactivated and needs explicit reapproval.",
  "unsupported-record-version": "This approval was recorded in a format this daemon no longer reads. It needs explicit reapproval.",
}

function ruleCreatedLabel(rule: ApprovalRule): string {
  const created = new Date(rule.createdAt)
  const stamp = Number.isNaN(created.getTime()) ? rule.createdAt : created.toLocaleString()
  return `Added by ${rule.createdBy} on ${stamp}`
}

function retiredLabel(inactivatedAt: string): string {
  const retired = new Date(inactivatedAt)
  const stamp = Number.isNaN(retired.getTime()) ? inactivatedAt : retired.toLocaleString()
  return `Retired on ${stamp}`
}

export function PermissionRuleSettings({ rules }: { rules: readonly ApprovalRule[] }) {
  const active = rules.filter((rule) => rule.status === "active")
  const retired = rules.filter((rule) => rule.status === "inactive")

  return (
    <>
      <h1 className="m-0 text-[17px] font-semibold">Permissions and rules</h1>
      <p className="mt-1.5 max-w-[68ch] text-[12.5px] leading-relaxed text-muted-foreground">
        Ask, Plan, and Build are per-session permission modes. Standing rules pre-approve one resolved command for the open project, and the daemon records a receipt for every decision they answer.
      </p>

      {retired.length > 0 ? (
        <Card className="mt-6 border-warning/40">
          <CardHeader>
            <CardTitle>Retired approval rules</CardTitle>
            <CardDescription>
              These rules no longer approve anything. They are kept so the record of who granted them survives, and the next matching request asks again.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul aria-label="Retired approval rules" className="m-0 flex list-none flex-col gap-0 p-0">
              {retired.map((rule, index) => (
                <li key={rule.id}>
                  {index > 0 ? <Separator /> : null}
                  <div className="flex flex-col gap-1 py-3">
                    <span className="font-machine text-[12px] text-muted-foreground line-through">{rule.command}</span>
                    <span className="text-[11px] leading-relaxed text-warning">
                      {rule.status === "inactive" ? inactiveReasonCopy[rule.inactiveReason] : null}
                    </span>
                    <span className="text-[10.5px] text-faint">
                      {ruleCreatedLabel(rule)}
                      {rule.status === "inactive" ? ` · ${retiredLabel(rule.inactivatedAt)}` : ""}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Standing approval rules</CardTitle>
          <CardDescription>
            Rules belong to the open project and stay on this machine. Hard gates never match a rule and always ask again.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {active.length === 0 ? (
            <p className="m-0 text-[12px] leading-relaxed text-muted-foreground">
              No standing rules for this project. Approving a request with Always adds one here.
            </p>
          ) : (
            <>
              <ul aria-label="Standing approval rules" className="m-0 flex list-none flex-col gap-0 p-0">
                {active.map((rule, index) => (
                  <li key={rule.id}>
                    {index > 0 ? <Separator /> : null}
                    <div className="flex flex-col gap-1 py-3">
                      <span className="font-machine text-[12px]">{rule.command}</span>
                      <span className="text-[10.5px] text-muted-foreground">Operation {rule.operation}</span>
                      <span className="text-[10.5px] text-faint">{ruleCreatedLabel(rule)}</span>
                    </div>
                  </li>
                ))}
              </ul>
              <p className="m-0 mt-3 border-t pt-3 text-[11px] leading-relaxed text-muted-foreground">
                Matches command and package-script text only. Config, plugins, source files, and dependency binaries may still change.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </>
  )
}
