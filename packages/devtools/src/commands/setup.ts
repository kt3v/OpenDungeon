import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { findProjectRoot } from "../lib/project-root.js";
import { println, printError, color, c, sym } from "../lib/output.js";

export async function runSetup(_args: string[]): Promise<void> {
  const root = findProjectRoot();

  println();
  println(color("Setting up OpenDungeon...", c.bold, c.cyan));
  println();

  const setupResult = spawnSync("node", [join(root, "scripts", "setup.mjs")], {
    stdio: "inherit",
    cwd: root,
  });

  if (setupResult.status !== 0) {
    printError("Setup failed. Check the output above for details.");
    process.exit(1);
  }

  println();

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Configure an AI provider now? [Y/n] ");
    const yes = answer.trim() === "" || answer.trim().toLowerCase() === "y";

    if (yes) {
      println();
      const llmResult = spawnSync(
        "node",
        [join(root, "scripts", "llm-setup.mjs")],
        { stdio: "inherit", cwd: root }
      );
      if (llmResult.status !== 0) {
        printError("LLM setup failed. You can run `od configure llm` later.");
      }
    }
  } finally {
    rl.close();
  }

  println();
  println(color(`${sym.ok} Setup complete!`, c.green, c.bold));
  println(color("  Run: od start", c.dim));
  println();
}
