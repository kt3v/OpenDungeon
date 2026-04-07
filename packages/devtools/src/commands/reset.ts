import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { findProjectRoot } from "../lib/project-root.js";
import { println, printError, color, c, sym } from "../lib/output.js";
import { runStop } from "./stop.js";

export async function runReset(_args: string[]): Promise<void> {
  println();
  println(color(`${sym.warn}  WARNING: This will delete:`, c.yellow, c.bold));
  println(color("    • Running services (gateway, web)", c.yellow));
  println(color("    • Database volumes (all campaign data will be lost)", c.yellow));
  println(color("    • node_modules/", c.yellow));
  println(color("    • .env (all your settings)", c.yellow));
  println(color("    • Build artifacts (dist/, .turbo/)", c.yellow));
  println();

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let confirmed = false;
  let deleteGames = false;
  let deleteWeb = false;

  try {
    const answer = await rl.question('Type YES to confirm reset (or anything else to cancel): ');
    confirmed = answer.trim() === "YES";

    if (confirmed) {
      const gamesAnswer = await rl.question('Also delete your game projects in games/ directory? [y/N]: ');
      deleteGames = gamesAnswer.trim().toLowerCase() === "y";

      const webAnswer = await rl.question('Also delete your web UI modules in web/ directory? [y/N]: ');
      deleteWeb = webAnswer.trim().toLowerCase() === "y";
    }
  } finally {
    rl.close();
  }

  if (!confirmed) {
    println();
    println("Reset cancelled.");
    println();
    return;
  }

  // Ensure services are stopped before cleaning up files
  await runStop(["full"]);

  println();
  const root = findProjectRoot();
  const scriptPath = join(root, "scripts", "clean-local-state.sh");

  const args = [
    ...(deleteGames ? ["--delete-games"] : []),
    ...(deleteWeb ? ["--delete-web"] : []),
  ];
  const result = spawnSync("bash", [scriptPath, ...args], {
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
