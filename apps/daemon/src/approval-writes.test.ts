import { readdirSync, readFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import ts from "typescript"
import { describe, expect, it } from "vitest"

// An approval reaches the snapshot only through the settlement ledger: the one
// place that pushes or replaces an approval, and only one that settleApproval
// made. Everywhere else may read approvals and remove them, never write one.
//
// The check reads each daemon source's syntax tree, without types. It follows
// an approval list or card reached through `approvals`, through a local name
// bound to one (a declaration, a destructured element, a for-of variable, or
// an array callback's first parameter, up to eight names deep, each in its own
// scope), and through a parameter or variable typed as an approval or an
// approval list. It does not follow a card returned from a function or method
// of the daemon's own, a card stored in a field of another object, or a list
// passed as an argument to a parameter that is not typed as one.

const sourceDirectory = dirname(fileURLToPath(import.meta.url))

// The ledger itself, and the store's load and save copies, which run before
// the daemon settles what it loaded.
const owners = new Set(["approval-settlement.ts", "store.ts", "workspace-redaction.ts"])

// Names the daemon gives a held approval card.
const approvalNames = new Set(["approval", "current", "pending", "candidateApproval", "held", "waiting"])

const listMutators = new Set(["push", "unshift", "splice", "fill", "copyWithin", "sort", "reverse"])
// Array methods that return one element, a new array of the same cards, or
// hand each card to a callback as its first parameter.
const elementMethods = new Set(["find", "findLast", "at"])
const copyMethods = new Set(["filter", "slice", "concat", "toSorted", "toReversed", "toSpliced", "with"])
const callbackMethods = new Set([
  "forEach", "map", "flatMap", "filter", "find", "findLast", "findIndex", "findLastIndex", "some", "every",
])
const objectWriters: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["Object", new Set(["assign", "defineProperty", "defineProperties", "setPrototypeOf"])],
  ["Reflect", new Set(["set", "defineProperty", "deleteProperty", "setPrototypeOf"])],
])

// "list" is the snapshot's own list; "copy" is a new array of the same cards;
// "named" is a name the daemon gives a card, bound to nothing the check can
// follow, where only a write of a field settlement derives counts.
type Kind = "list" | "copy" | "approval" | "named"

const settledFields = new Set(["risk", "operation", "command", "directory", "affects", "network", "execution"])

// Names bound to names are followed this many links deep.
const maximumAliasDepth = 8

function unwrap(node: ts.Expression): ts.Expression {
  let current = node
  while (
    ts.isParenthesizedExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isTypeAssertionExpression(current)
  ) current = current.expression
  return current
}

function accessedName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  return ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined
}

function kindOfType(type: ts.TypeNode | undefined, source: ts.SourceFile): Kind | undefined {
  if (type === undefined) return undefined
  const text = type.getText(source).replace(/\s+/gu, "")
  if (/\["approvals"\]\[number\]$|^(?:Settled)?Approval$|^Readonly<(?:Settled)?Approval>$/u.test(text)) return "approval"
  if (/\["approvals"\]$|^(?:readonly)?(?:Settled)?Approval\[\]$/u.test(text)) return "list"
  return undefined
}

// The scope a binding lives in: its function for a parameter, else the nearest
// block, loop header, catch clause, function or file.
function scopeOf(node: ts.Node): ts.Node {
  let current = node.parent
  while (
    !ts.isSourceFile(current)
    && !ts.isBlock(current)
    && !ts.isModuleBlock(current)
    && !ts.isCaseBlock(current)
    && !ts.isCatchClause(current)
    && !ts.isForStatement(current)
    && !ts.isForOfStatement(current)
    && !ts.isForInStatement(current)
    && !ts.isFunctionLike(current)
  ) current = current.parent
  return current
}

function scanApprovalWrites(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  // Every local name, with the scope it is bound in and what it holds, if an
  // approval list or card. The innermost binding that encloses a use wins, so
  // a name bound again to something else hides an outer card.
  let bindings = new Map<string, { scope: ts.Node; kind: Kind | undefined }[]>()

  const bound = (identifier: ts.Identifier): { found: boolean; kind: Kind | undefined } => {
    let best: { scope: ts.Node; kind: Kind | undefined } | undefined
    for (const binding of bindings.get(identifier.text) ?? []) {
      const encloses = binding.scope.pos <= identifier.pos && identifier.end <= binding.scope.end
      if (encloses && (best === undefined || binding.scope.end - binding.scope.pos < best.scope.end - best.scope.pos)) best = binding
    }
    return { found: best !== undefined, kind: best?.kind }
  }

  const kindOf = (node: ts.Expression): Kind | undefined => {
    const expression = unwrap(node)
    if (ts.isIdentifier(expression)) {
      const binding = bound(expression)
      if (binding.kind !== undefined) return binding.kind
      if (expression.text === "approvals") return "list"
      return approvalNames.has(expression.text) ? "named" : undefined
    }
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      if (accessedName(expression) === "approvals") return "list"
      const owner = kindOf(expression.expression)
      if ((owner === "list" || owner === "copy") && ts.isElementAccessExpression(expression)) return "approval"
      return undefined
    }
    if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(unwrap(expression.expression))) {
      const callee = unwrap(expression.expression) as ts.PropertyAccessExpression
      const owner = kindOf(callee.expression)
      if (owner !== "list" && owner !== "copy") return undefined
      if (elementMethods.has(callee.name.text)) return "approval"
      if (copyMethods.has(callee.name.text)) return "copy"
      return undefined
    }
    if (ts.isConditionalExpression(expression)) return kindOf(expression.whenTrue) ?? kindOf(expression.whenFalse)
    if (ts.isBinaryExpression(expression) && [
      ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken,
    ].includes(expression.operatorToken.kind)) return kindOf(expression.right) ?? kindOf(expression.left)
    return undefined
  }

  const isList = (kind: Kind | undefined) => kind === "list" || kind === "copy"

  const bind = (
    next: Map<string, { scope: ts.Node; kind: Kind | undefined }[]>,
    name: ts.BindingName,
    kind: Kind | undefined,
  ): void => {
    if (ts.isIdentifier(name)) {
      next.set(name.text, [...next.get(name.text) ?? [], { scope: scopeOf(name.parent), kind }])
      return
    }
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) continue
      if (ts.isArrayBindingPattern(name)) {
        bind(next, element.name, isList(kind) ? element.dotDotDotToken ? "copy" : "approval" : undefined)
      } else {
        const key = element.propertyName ?? element.name
        bind(next, element.name, ts.isIdentifier(key) && key.text === "approvals" ? "list" : undefined)
      }
    }
  }

  // Every binding, read again with what the last round found, until a round
  // finds no new list or card.
  const collect = (next: Map<string, { scope: ts.Node; kind: Kind | undefined }[]>) => {
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node)) {
        const loop = node.parent.parent
        const element = ts.isForOfStatement(loop) && isList(kindOf(loop.expression)) ? "approval" : undefined
        bind(next, node.name, element ?? kindOfType(node.type, source) ?? (node.initializer ? kindOf(node.initializer) : undefined))
      } else if (ts.isParameter(node)) {
        const callback = node.parent
        const call = callback.parent
        const card = (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
          && callback.parameters[0] === node
          && ts.isCallExpression(call)
          && call.arguments[0] === callback
          && ts.isPropertyAccessExpression(unwrap(call.expression))
          && callbackMethods.has((unwrap(call.expression) as ts.PropertyAccessExpression).name.text)
          && isList(kindOf((unwrap(call.expression) as ts.PropertyAccessExpression).expression))
        bind(next, node.name, card ? "approval" : kindOfType(node.type, source))
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  const known = (map: typeof bindings) => [...map.values()].flat().filter(({ kind }) => kind !== undefined).length
  for (let round = 0; round < maximumAliasDepth; round += 1) {
    const next = new Map<string, { scope: ts.Node; kind: Kind | undefined }[]>()
    collect(next)
    const settled = known(next) === known(bindings)
    bindings = next
    if (settled) break
  }

  // Whether an access chain writes into a card, or into the list itself.
  const written = (target: ts.Expression): string | undefined => {
    const expression = unwrap(target)
    if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return undefined
    const owner = kindOf(expression.expression)
    if (owner === "list") return "writes an approval list entry"
    if (owner === "approval" || owner === "copy") return "writes an approval card field"
    if (owner === "named") return settledFields.has(accessedName(expression) ?? "") ? "writes a settled field" : undefined
    let inner = unwrap(expression.expression)
    while (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner)) {
      const holder = kindOf(inner.expression)
      if (holder === "approval" || (holder === "named" && settledFields.has(accessedName(inner) ?? ""))) {
        return "writes inside an approval card"
      }
      inner = unwrap(inner.expression)
    }
    return undefined
  }

  // Assigning the list is allowed only to remove entries from it, or all.
  const removal = (value: ts.Expression): boolean => {
    const expression = unwrap(value)
    if (ts.isArrayLiteralExpression(expression)) return expression.elements.length === 0
    if (!ts.isCallExpression(expression)) return false
    const callee = unwrap(expression.expression)
    return ts.isPropertyAccessExpression(callee) && callee.name.text === "filter" && kindOf(callee.expression) === "list"
  }

  const found: string[] = []
  const report = (node: ts.Node, rule: string) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
    found.push(`${file}:${line}: ${rule}: ${node.getText(source).split("\n")[0]!.trim()}`)
  }

  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const target = unwrap(node.left)
      if ((ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) && accessedName(target) === "approvals") {
        if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !removal(node.right)) report(node, "assigns the approval list")
      } else {
        const rule = written(target)
        if (rule) report(node, rule)
      }
    } else if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
      const rule = written(node.operand)
      if (rule) report(node, rule)
    } else if (ts.isDeleteExpression(node)) {
      const rule = written(node.expression)
      if (rule) report(node, rule)
    } else if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression)
      if (ts.isPropertyAccessExpression(callee)) {
        const holder = unwrap(callee.expression)
        const writers = ts.isIdentifier(holder) ? objectWriters.get(holder.text) : undefined
        if (writers?.has(callee.name.text) && node.arguments[0]) {
          const argument = node.arguments[0]
          const kind = kindOf(argument)
          if (kind === "list" || kind === "approval" || written(argument)) report(node, `writes an approval through ${holder.getText(source)}.${callee.name.text}`)
        } else if (listMutators.has(callee.name.text) && kindOf(callee.expression) === "list") {
          report(node, "adds or reorders approvals")
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function sources(directory: string): { file: string; text: string }[] {
  return readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((path) => {
      const name = basename(path)
      return path.endsWith(".ts") && !name.endsWith(".test.ts") && !name.startsWith("test-") && !owners.has(path)
    })
    .map((path) => ({ file: path.replaceAll("\\", "/"), text: readFileSync(join(directory, path), "utf8") }))
}

describe("approval writes", () => {
  it("go through the settlement ledger in every daemon source", () => {
    const found = sources(sourceDirectory).flatMap(({ file, text }) => scanApprovalWrites(file, text))
    expect(found).toEqual([])
  })

  it("finds the ledger's own writes, which it exempts", () => {
    const ledger = readFileSync(join(sourceDirectory, "approval-settlement.ts"), "utf8")
    const rules = scanApprovalWrites("approval-settlement.ts", ledger).map((line) => line.split(": ")[1])
    expect(rules).toEqual(expect.arrayContaining(["adds or reorders approvals", "writes an approval list entry"]))
  })

  it("catches each kind of write it forbids", () => {
    const probes = [
      "this.#snapshot.approvals.push(approval)",
      "snapshot.approvals.unshift(copy)",
      "this.#snapshot.approvals[0] = approval",
      "this.#snapshot.approvals[index].risk = \"normal\"",
      "this.#snapshot.approvals = restored?.approvals ?? []",
      "candidate.approvals = [...candidate.approvals, approval]",
      "current.risk = \"hard-gate\"",
      "approval.execution = currentExecution",
      "const list = this.#snapshot.approvals; list.push(approval)",
      "const card = this.#snapshot.approvals[0]!; card.risk = \"normal\"",
      "const card = this.#snapshot.approvals.find(({ id }) => id === approvalId)!; const same = card; same.affects = text",
      "this.#snapshot.approvals[0]![\"risk\"] = \"normal\"",
      "const card = this.#snapshot.approvals[0]!; card[field] = value",
      "Object.assign(this.#snapshot.approvals[0]!, { risk: \"normal\" })",
      "Object.defineProperty(this.#snapshot.approvals[0]!, \"risk\", { value: \"normal\" })",
      "Reflect.set(card, \"risk\", \"normal\"); const card = snapshot.approvals.at(-1)",
      "for (const card of this.#snapshot.approvals) card.directory = directory",
      "this.#snapshot.approvals.forEach((card) => { card.execution.state = \"resolved\" })",
      "const [first] = this.#snapshot.approvals; delete first!.affects",
      "function change(card: WorkspaceSnapshot[\"approvals\"][number]) { card.network = text }",
      "const { approvals: list } = this.#snapshot; list[0] = approval",
      "this.#snapshot[\"approvals\"] = [...this.#snapshot.approvals, approval]",
    ]
    expect(probes.filter((probe) => scanApprovalWrites("probe.ts", probe).length === 0)).toEqual([])
    for (const allowed of [
      "candidate.approvals = candidate.approvals.filter((a) => a.id !== id)",
      "this.#snapshot.approvals = []",
      "const card = this.#snapshot.approvals.find(({ id }) => id === approvalId); if (card?.risk === \"normal\") send(card)",
      "const kept = this.#snapshot.approvals.map((card) => ({ ...card, risk: \"hard-gate\" as const }))",
      "const ids = this.#snapshot.approvals.filter(({ risk }) => risk === \"normal\").sort(byTime)",
    ]) {
      expect(scanApprovalWrites("allowed.ts", allowed)).toEqual([])
    }
  })
})
