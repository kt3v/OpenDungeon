#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { moduleManifestSchema } from "@opendungeon/shared";
import { runArchitectCli } from "./architect-cli.js";
import { printHelp, printError } from "./lib/output.js";
import { runSetup } from "./commands/setup.js";
import { runStart } from "./commands/start.js";
import { runStop } from "./commands/stop.js";
import { runStatus } from "./commands/status.js";
import { runLogs } from "./commands/logs.js";
import { runConfigure } from "./commands/configure.js";
import { runReset } from "./commands/reset.js";
import { runCreateModule } from "./commands/create-module.js";

const command = process.argv[2];
const restArgs = process.argv.slice(3);

try {
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;

    case "setup":
      await runSetup(restArgs);
      break;

    case "start":
      await runStart(restArgs);
      break;

    case "stop":
      await runStop(restArgs);
      break;

    case "status":
      await runStatus(restArgs);
      break;

    case "logs":
      await runLogs(restArgs);
      break;

    case "configure":
      await runConfigure(restArgs);
      break;

    case "reset":
      await runReset(restArgs);
      break;

    case "create-module":
    case "create-game-module":
      await runCreateModule(restArgs);
      break;

    case "architect":
      await runArchitectCli(restArgs);
      break;

    case "validate-module": {
      const target = restArgs[0];
      if (!target) {
        process.stdout.write("Usage: od validate-module <path-to-manifest.json>\n");
        process.exit(1);
      }
      const fullPath = resolve(process.cwd(), target);
      const content = await readFile(fullPath, "utf8");
      const manifest = JSON.parse(content) as unknown;
      moduleManifestSchema.parse(manifest);
      process.stdout.write(`Valid module manifest: ${fullPath}\n`);
      break;
    }

    default:
      printError(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\x1b[31mError:\x1b[0m ${msg}\n`);
  process.exit(1);
}
