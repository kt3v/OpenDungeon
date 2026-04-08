import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { findProjectRoot } from "../lib/project-root.js";
import { println, printError, color, c, sym } from "../lib/output.js";

export async function runSetup(args: string[]): Promise<void> {
  const root = findProjectRoot();

  println();
  println(color("Setting up OpenDungeon...", c.bold, c.cyan));
  println();

  // Parse setup mode: 'web', 'game', or full setup
  const mode = args[0];
  const setupArgs: string[] = [];

  if (mode === "web") {
    setupArgs.push("--web-only");
    println(color("Mode: Web UI only", c.dim));
  } else if (mode === "game") {
    setupArgs.push("--game-only");
    println(color("Mode: Game module only", c.dim));
  } else if (mode) {
    printError(`Unknown setup mode: ${mode}`);
    println("Usage: od setup [web|game]");
    println("  od setup       Full setup (game module + web UI + database)");
    println("  od setup web   Web UI only");
    println("  od setup game  Game module only");
    process.exit(1);
  }

  const setupResult = spawnSync("node", [join(root, "scripts", "setup.mjs"), ...setupArgs], {
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
