import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function findProjectRoot(): string {
  let dir = resolve(process.cwd());
  while (true) {
    if (existsSync(join(dir, "turbo.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        "Could not find OpenDungeon project root (no turbo.json found).\n" +
          "Run od from inside the project directory."
      );
    }
    dir = parent;
  }
}

export function getProjectId(projectRoot: string): string {
  return createHash("sha256").update(projectRoot).digest("hex").slice(0, 12);
}
