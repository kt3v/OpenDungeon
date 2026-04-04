#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = join(__dirname, "..", "dist", "cli.js");

if (!existsSync(cliPath)) {
  process.stderr.write(`\x1b[31mError:\x1b[0m OpenDungeon CLI not built. Please run \x1b[1mpnpm build\x1b[0m first.\n`);
  process.exit(1);
}

await import("file://" + cliPath);
