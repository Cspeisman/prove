import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { API } from "typescript/unstable/sync";
import type * as ts from "typescript/unstable/ast";

export function parseSourceFile(file: string): ts.SourceFile {
  const absolutePath = path.resolve(file);

  // TS 7 has no standalone parser; files are parsed through a project.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prove-"));
  const tsconfig = path.join(tmpDir, "tsconfig.json");
  fs.writeFileSync(
    tsconfig,
    JSON.stringify({ files: [absolutePath] }),
  );

  const api = new API({ cwd: process.cwd() });

  try {
    const project = api
      .updateSnapshot({ openProject: tsconfig })
      .getProject(tsconfig);
    const parsed = project?.program.getSourceFile(absolutePath);

    if (!parsed) {
      throw new Error(`Could not parse ${file}`);
    }

    return parsed;
  } finally {
    api.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
