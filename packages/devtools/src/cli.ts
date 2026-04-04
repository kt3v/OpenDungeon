#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { moduleManifestSchema } from "@opendungeon/shared";
import { runArchitectCli } from "./architect-cli.js";

const command = process.argv[2];

if (command === "architect") {
  await runArchitectCli(process.argv.slice(3));
} else if (command === "validate-module") {
  const target = process.argv[3];
  if (!target) {
    process.stdout.write("Usage: od validate-module <path-to-manifest.json>\n");
    process.exit(1);
  }
  const fullPath = resolve(process.cwd(), target);
  const content = await readFile(fullPath, "utf8");
  const manifest = JSON.parse(content) as unknown;
  moduleManifestSchema.parse(manifest);
  process.stdout.write(`Valid module manifest: ${fullPath}\n`);
} else {
  process.stdout.write("Usage:\n");
  process.stdout.write("  od validate-module <path-to-manifest.json>\n");
  process.stdout.write("  od architect --campaign <campaignId> [--module <path>] [--apply]\n");
  process.exit(1);
}
