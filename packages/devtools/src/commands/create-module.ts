import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { findProjectRoot } from "../lib/project-root.js";
import { printError } from "../lib/output.js";

export async function runCreateModule(args: string[]): Promise<void> {
  const root = findProjectRoot();

  const result = spawnSync(
    "node",
    [join(root, "scripts", "create-game-module.mjs"), ...args],
    {
      stdio: "inherit",
      cwd: root,
    }
  );

  if (result.status !== 0) {
    printError("Module creation failed.");
    process.exit(result.status ?? 1);
  }
}
