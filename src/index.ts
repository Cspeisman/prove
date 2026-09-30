#!/usr/bin/env node

import * as ts from "typescript/unstable/ast";
import { parseSourceFile } from "./parse.js";
import { verifyFunction } from "./verify.js";

const filePath = process.argv[2];

if (!filePath) {
  console.error("Usage: prove <file.ts>");
  process.exit(1);
}

const sourceFile = parseSourceFile(filePath);

interface Contract {
  requires: string[];
  ensures: string[];
}

interface FunctionDefinition {
  name: string;

  parameters: {
    name: string;
    type: string;
  }[];

  returnType: string | undefined;

  contract: Contract;

  returnExpression: string | undefined;
}

function getContract(node: ts.FunctionDeclaration): Contract {
  const requires: string[] = [];
  const ensures: string[] = [];

  for (const doc of node.jsDoc ?? []) {
    if (!ts.isJSDoc(doc)) {
      continue;
    }

    for (const tag of doc.tags ?? []) {
      const tagName = tag.tagName.text;

      const comment = ts.getTextOfJSDocComment(tag.comment)?.trim();

      if (!comment) {
        continue;
      }

      if (tagName === "requires") {
        requires.push(comment);
      }

      if (tagName === "ensures") {
        ensures.push(comment);
      }
    }
  }

  return {
    requires,
    ensures,
  };
}

function getReturnExpression(node: ts.FunctionDeclaration): string | undefined {
  if (!node.body) {
    return undefined;
  }

  for (const statement of node.body.statements) {
    if (ts.isReturnStatement(statement) && statement.expression) {
      return statement.expression.getText(sourceFile);
    }
  }

  return undefined;
}

function parseFunction(
  node: ts.FunctionDeclaration,
): FunctionDefinition | undefined {
  if (!node.name) {
    return undefined;
  }

  return {
    name: node.name.text,

    parameters: node.parameters.map((parameter) => ({
      name: parameter.name.getText(sourceFile),
      type: parameter.type?.getText(sourceFile) ?? "unknown",
    })),

    returnType: node.type?.getText(sourceFile),

    contract: getContract(node),

    returnExpression: getReturnExpression(node),
  };
}

function findFunctions(sourceFile: ts.SourceFile): FunctionDefinition[] {
  const functions: FunctionDefinition[] = [];

  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node)) {
      const fn = parseFunction(node);

      if (fn) {
        functions.push(fn);
      }
    }

    node.forEachChild(visit);
  }

  visit(sourceFile);

  return functions;
}

const functions = findFunctions(sourceFile);

async function main() {
  console.log(`\nAnalyzing ${filePath}\n`);

  let failures = 0;

  for (const fn of functions) {
    console.log(fn.name);

    for (const parameter of fn.parameters) {
      console.log(`  parameter: ${parameter.name}: ${parameter.type}`);
    }

    for (const requirement of fn.contract.requires) {
      console.log(`  requires: ${requirement}`);
    }

    for (const guarantee of fn.contract.ensures) {
      console.log(`  ensures: ${guarantee}`);
    }

    if (fn.returnExpression) {
      console.log(`  returns: ${fn.returnExpression}`);
    }

    if (fn.contract.ensures.length > 0) {
      const result = await verifyFunction(fn);

      if (result.ok) {
        console.log("  PASS");
      } else {
        failures++;
        console.log(`  FAIL: ${result.reason}`);
      }
    }

    console.log();
  }

  if (failures > 0) {
    console.error(`${failures} function(s) failed verification`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
