import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { findProjectRoot } from "../lib/project-root.js";
import { println, printError, color, c, sym } from "../lib/output.js";

export async function runReset(_args: string[]): Promise<void> {
  println();
  println(color(`${sym.warn}  WARNING: This will delete:`, c.yellow, c.bold));
  println(color("    • Database volumes (all game data will be lost)", c.yellow));
  println(color("    • node_modules/", c.yellow));
  println(color("    • .env.local (all your settings)", c.yellow));
  println(color("    • Build artifacts (.next/, dist/, .turbo/)", c.yellow));
  println();

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let confirmed = false;

  try {
    const answer = await rl.question('Type YES to confirm reset (or anything else to cancel): ');
    confirmed = answer.trim() === "YES";
  } finally {
    rl.close();
  }

  if (!confirmed) {
    println();
    println("Reset cancelled.");
    println();
    return;
  }

  println();
  const root = findProjectRoot();
  const scriptPath = join(root, "scripts", "clean-local-state.sh");

  const result = spawnSync("bash", [scriptPath], {
    stdio: "inherit",
    cwd: root,
  });

  if (result.status !== 0) {
    printError("Reset failed. Check the output above.");
    process.exit(1);
  }

  println();
  println(color(`${sym.ok} Reset complete.`, c.green, c.bold));
  println(color("  Run: od setup", c.dim));
  println();
}
