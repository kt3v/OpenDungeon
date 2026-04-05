#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { access, readdir } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { moduleManifestSchema, classesFileSchema, dmConfigFileSchema, initialStateFileSchema, hookSchema, ruleSchema } from "@opendungeon/shared";
import { runArchitectCli } from "./architect-cli.js";
import { runArchitectAnalyze } from "./architect-analyze.js";
import { runArchitectScaffold } from "./architect-scaffold.js";
import { printHelp, printError } from "./lib/output.js";
import { runSetup } from "./commands/setup.js";
import { runStart } from "./commands/start.js";
import { runStop } from "./commands/stop.js";
import { runStatus } from "./commands/status.js";
import { runLogs } from "./commands/logs.js";
import { runRealtime } from "./commands/realtime.js";
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

    case "realtime":
      await runRealtime(restArgs);
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

    case "architect": {
      const subcommand = restArgs[0];
      if (subcommand === "analyze") {
        await runArchitectAnalyze(restArgs.slice(1));
      } else if (subcommand === "scaffold") {
        await runArchitectScaffold(restArgs.slice(1));
      } else {
        await runArchitectCli(restArgs);
      }
      break;
    }

    case "validate-module": {
      const target = restArgs[0];
      if (!target) {
        process.stdout.write("Usage: od validate-module <path-to-manifest.json | module-dir>\n");
        process.exit(1);
      }

      const targetPath = resolve(process.cwd(), target);
      // Accept either a path to manifest.json or to the module directory
      const manifestPath = targetPath.endsWith("manifest.json")
        ? targetPath
        : join(targetPath, "manifest.json");
      const moduleDir = dirname(manifestPath);

      const errors: string[] = [];
      let hasAny = false;

      // manifest.json (required)
      try {
        const content = await readFile(manifestPath, "utf8");
        const manifest = JSON.parse(content) as unknown;
        moduleManifestSchema.parse(manifest);
        process.stdout.write(`✓ manifest.json\n`);
        hasAny = true;
      } catch (err) {
        errors.push(`manifest.json: ${err instanceof Error ? err.message : String(err)}`);
      }

      // classes.json (optional)
      const classesPath = join(moduleDir, "classes.json");
      try {
        await access(classesPath);
        const content = await readFile(classesPath, "utf8");
        classesFileSchema.parse(JSON.parse(content));
        process.stdout.write(`✓ classes.json\n`);
        hasAny = true;
      } catch (err: unknown) {
        if (!(err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT")) {
          errors.push(`classes.json: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // dm-config.json (optional)
      const dmConfigPath = join(moduleDir, "dm-config.json");
      try {
        await access(dmConfigPath);
        const content = await readFile(dmConfigPath, "utf8");
        dmConfigFileSchema.parse(JSON.parse(content));
        process.stdout.write(`✓ dm-config.json\n`);
        hasAny = true;
      } catch (err: unknown) {
        if (!(err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT")) {
          errors.push(`dm-config.json: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // initial-state.json (optional)
      const initialStatePath = join(moduleDir, "initial-state.json");
      try {
        await access(initialStatePath);
        const content = await readFile(initialStatePath, "utf8");
        initialStateFileSchema.parse(JSON.parse(content));
        process.stdout.write(`✓ initial-state.json\n`);
        hasAny = true;
      } catch (err: unknown) {
        if (!(err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT")) {
          errors.push(`initial-state.json: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // hooks/*.json (optional)
      const hooksDir = join(moduleDir, "hooks");
      try {
        const hookFiles = await readdir(hooksDir);
        const jsonHooks = hookFiles.filter((f) => f.endsWith(".json"));
        for (const file of jsonHooks) {
          try {
            const content = await readFile(join(hooksDir, file), "utf8");
            hookSchema.parse(JSON.parse(content));
            process.stdout.write(`✓ hooks/${file}\n`);
            hasAny = true;
          } catch (err) {
            errors.push(`hooks/${file}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } catch {
        // hooks/ dir absent — that's fine
      }

      // rules/*.json (optional)
      const rulesDir = join(moduleDir, "rules");
      try {
        const ruleFiles = await readdir(rulesDir);
        const jsonRules = ruleFiles.filter((f) => f.endsWith(".json"));
        for (const file of jsonRules) {
          try {
            const content = await readFile(join(rulesDir, file), "utf8");
            ruleSchema.parse(JSON.parse(content));
            process.stdout.write(`✓ rules/${file}\n`);
            hasAny = true;
          } catch (err) {
            errors.push(`rules/${file}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } catch {
        // rules/ dir absent — that's fine
      }

      if (!hasAny && errors.length === 0) {
        process.stdout.write("No module files found. Provide a path to a module directory or manifest.json.\n");
        process.exit(1);
      }

      if (errors.length > 0) {
        process.stderr.write(`\nValidation errors:\n`);
        for (const err of errors) {
          process.stderr.write(`  ✗ ${err}\n`);
        }
        process.exit(1);
      }

      process.stdout.write(`\nAll files valid.\n`);
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
