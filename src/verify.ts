import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { init } from "z3-solver";
import * as ts from "typescript/unstable/ast";
import { parseSourceFile } from "./parse.js";

export interface VerifiableFunction {
  name: string;
  parameters: { name: string; type: string }[];
  contract: { requires: string[]; ensures: string[] };
  returnExpression: string | undefined;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: string };

// Numbers are modelled as reals, so this proves the contract over
// mathematical arithmetic, not IEEE-754 (no NaN, overflow or rounding).
async function createZ3() {
  const { Context } = await init();
  return Context("main");
}

type Z3 = Awaited<ReturnType<typeof createZ3>>;
let z3Promise: Promise<Z3> | undefined;

function parseExpressions(sources: string[]): ts.Expression[] {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prove-expr-"));
  const file = path.join(tmpDir, "expressions.ts");

  try {
    fs.writeFileSync(
      file,
      sources.map((source) => `(${source});`).join("\n"),
    );

    return parseSourceFile(file).statements.map((statement) => {
      if (!ts.isExpressionStatement(statement)) {
        throw new Error("Not a single expression");
      }
      return statement.expression;
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function translate(z3: Z3, node: ts.Node, vars: Map<string, any>): any {
  if (ts.isParenthesizedExpression(node)) {
    return translate(z3, node.expression, vars);
  }

  if (ts.isNumericLiteral(node)) {
    return z3.Real.val(node.text);
  }

  if (ts.isIdentifier(node)) {
    const value = vars.get(node.text);
    if (!value) {
      throw new Error(`Unknown identifier '${node.text}'`);
    }
    return value;
  }

  if (ts.isPrefixUnaryExpression(node)) {
    const operand = translate(z3, node.operand, vars);
    if (node.operator === ts.SyntaxKind.MinusToken) return operand.neg();
    if (node.operator === ts.SyntaxKind.PlusToken) return operand;
    if (node.operator === ts.SyntaxKind.ExclamationToken) {
      return z3.Not(operand);
    }
  }

  if (ts.isBinaryExpression(node)) {
    const l = translate(z3, node.left, vars);
    const r = translate(z3, node.right, vars);

    switch (node.operatorToken.kind) {
      case ts.SyntaxKind.PlusToken: return l.add(r);
      case ts.SyntaxKind.MinusToken: return l.sub(r);
      case ts.SyntaxKind.AsteriskToken: return l.mul(r);
      case ts.SyntaxKind.SlashToken: return l.div(r);
      case ts.SyntaxKind.LessThanToken: return l.lt(r);
      case ts.SyntaxKind.LessThanEqualsToken: return l.le(r);
      case ts.SyntaxKind.GreaterThanToken: return l.gt(r);
      case ts.SyntaxKind.GreaterThanEqualsToken: return l.ge(r);
      case ts.SyntaxKind.EqualsEqualsToken:
      case ts.SyntaxKind.EqualsEqualsEqualsToken: return l.eq(r);
      case ts.SyntaxKind.ExclamationEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsEqualsToken: return l.neq(r);
      case ts.SyntaxKind.AmpersandAmpersandToken: return z3.And(l, r);
      case ts.SyntaxKind.BarBarToken: return z3.Or(l, r);
    }
  }

  throw new Error(`Unsupported expression: ${node.getText()}`);
}

export async function verifyFunction(
  fn: VerifiableFunction,
): Promise<VerifyResult> {
  if (!fn.returnExpression) {
    return {
      ok: false,
      reason: "has @ensures but no top-level return expression to check",
    };
  }

  const z3 = await (z3Promise ??= createZ3());
  const { requires, ensures } = fn.contract;

  try {
    const vars = new Map<string, any>();

    for (const parameter of fn.parameters) {
      if (parameter.type === "number") {
        vars.set(parameter.name, z3.Real.const(parameter.name));
      } else if (parameter.type === "boolean") {
        vars.set(parameter.name, z3.Bool.const(parameter.name));
      } else {
        throw new Error(
          `Unsupported parameter type '${parameter.type}'`,
        );
      }
    }

    const parsed = parseExpressions([
      fn.returnExpression,
      ...requires,
      ...ensures,
    ]);
    const [returned, ...rest] = parsed;
    const requireNodes = rest.slice(0, requires.length);
    const ensureNodes = rest.slice(requires.length);

    const returnValue = translate(z3, returned, vars);
    vars.set(
      "result",
      returnValue.sort.name() === "Bool"
        ? z3.Bool.const("result")
        : z3.Real.const("result"),
    );

    for (let i = 0; i < ensureNodes.length; i++) {
      const solver = new z3.Solver();

      for (const node of requireNodes) {
        solver.add(translate(z3, node, vars));
      }
      solver.add(vars.get("result").eq(returnValue));
      const guarantee: ReturnType<Z3["Bool"]["const"]> = translate(
        z3,
        ensureNodes[i],
        vars,
      );
      solver.add(z3.Not(guarantee));

      const verdict = await solver.check();

      if (verdict === "sat") {
        const model = solver.model();
        const counterexample = [...vars]
          .map(([name, value]) => `${name} = ${model.eval(value)}`)
          .join(", ");
        return {
          ok: false,
          reason: `@ensures ${ensures[i]} can be violated when ${counterexample}`,
        };
      }

      if (verdict === "unknown") {
        return {
          ok: false,
          reason: `solver could not decide @ensures ${ensures[i]}`,
        };
      }
    }

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
