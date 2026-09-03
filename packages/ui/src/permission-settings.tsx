import type { ApprovalRule } from "@getdomovoi/protocol"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"

function ruleCreatedLabel(rule: ApprovalRule): string {
  const created = new Date(rule.createdAt)
  const stamp = Number.isNaN(created.getTime()) ? rule.createdAt : created.toLocaleString()
  return `Added by ${rule.createdBy} on ${stamp}`
}

export function PermissionRuleSettings({ rules }: { rules: readonly ApprovalRule[] }) {
  return (
    <>
      <h1 className="m-0 text-[17px] font-semibold">Permissions and rules</h1>
      <p className="mt-1.5 max-w-[68ch] text-[12.5px] leading-relaxed text-muted-foreground">
        Ask, Plan, and Build are per-session permission modes. Standing rules pre-approve one operation for the open project, and the daemon records a receipt for every decision they answer.
      </p>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Standing approval rules</CardTitle>
          <CardDescription>
            Rules belong to the open project and stay on this machine. Hard gates never match a rule and always ask again.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rules.length === 0 ? (
            <p className="m-0 text-[12px] leading-relaxed text-muted-foreground">
              No standing rules for this project. Approving a request with Always adds one here.
            </p>
          ) : (
            <ul aria-label="Standing approval rules" className="m-0 flex list-none flex-col gap-0 p-0">
              {rules.map((rule, index) => (
                <li key={rule.id}>
                  {index > 0 ? <Separator /> : null}
                  <div className="flex flex-col gap-1 py-3">
                    <span className="font-machine text-[12px]">{rule.command}</span>
                    <span className="text-[10.5px] text-muted-foreground">
                      Operation {rule.operation}
                    </span>
                    <span className="text-[10.5px] text-faint">{ruleCreatedLabel(rule)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  )
}
