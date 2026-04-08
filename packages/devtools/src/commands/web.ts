import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { findProjectRoot } from "../lib/project-root.js";
import { println, printError } from "../lib/output.js";

export async function runWeb(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    println();
    println("Usage: od web sync [--force]");
    println();
    println("  sync      Copy updates from apps/web into WEB_MODULE_PATH");
    println("  --force   Overwrite existing changed files in WEB_MODULE_PATH");
    println();
    return;
  }

  if (subcommand !== "sync") {
    printError(`Unknown web subcommand: ${subcommand}`);
    println("Usage: od web sync [--force]");
    process.exit(1);
  }

  const root = findProjectRoot();
  const result = spawnSync("node", [join(root, "scripts", "sync-web-module.mjs"), ...args.slice(1)], {
    stdio: "inherit",
    cwd: root,
  });

  if (result.status !== 0) {
    printError("Web module sync failed.");
    process.exit(result.status ?? 1);
  }
}
