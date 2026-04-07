/**
 * od architect scaffold
 *
 * Generates or migrates declarative game module files (classes.json, dm.md,
 * dm-config.json, initial-state.json, hooks/*.json) using the Architect LLM.
 *
 * Usage:
 *   od architect scaffold [--module <path>] [--type classes|dm|initial-state|hooks|all]
 *                         [--migrate] [--dry-run]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { GameScaffolderRuntime } from "@opendungeon/architect";
import type { ScaffoldInput } from "@opendungeon/architect";
import { color, c, println, printError, printHeader } from "./lib/output.js";

type TargetFile = "classes" | "dm" | "initial-state";

interface ScaffoldArgs {
  modulePath: string;
  targetFiles: TargetFile[];
  migrate: boolean;
  dryRun: boolean;
}

const SUPPORTED_TYPES: TargetFile[] = ["classes", "dm", "initial-state"];

const parseArgs = (argv: string[]): ScaffoldArgs | null => {
  let modulePath = process.cwd();
  let targetFiles: TargetFile[] = [];
  let migrate = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--module") {
      const val = argv[++i];
      if (!val) {
        printError("Missing value for --module");
        return null;
      }
      modulePath = resolve(process.cwd(), val);
      continue;
    }

    if (arg === "--type") {
      const val = argv[++i];
      if (!val) {
        printError("Missing value for --type");
        return null;
      }
      if (val === "all") {
        targetFiles = [...SUPPORTED_TYPES];
      } else {
        const parts = val.split(",").map((t) => t.trim()) as TargetFile[];
        for (const part of parts) {
          if (!SUPPORTED_TYPES.includes(part)) {
            printError(`Unknown type: ${part}. Supported: ${SUPPORTED_TYPES.join(", ")}, all`);
            return null;
          }
        }
        targetFiles = parts;
      }
      continue;
    }

    if (arg === "--migrate") {
      migrate = true;
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
  }

  if (targetFiles.length === 0) {
    targetFiles = [...SUPPORTED_TYPES];
  }

  return { modulePath, targetFiles, migrate, dryRun };
};

const readFileIfExists = (filePath: string): string | undefined => {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
};

const prompt = async (question: string): Promise<string> => {
  const rl = createInterface({ input, output });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
};

export async function runArchitectScaffold(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    println("Usage: od architect scaffold [--module <path>] [--type classes|dm|initial-state|all] [--migrate] [--dry-run]");
    println();
    println("Options:");
    println("  --module   Path to the game module directory (default: current directory)");
    println("  --type     Which files to generate: classes, dm, initial-state, or all (default: all)");
    println("  --migrate  Read existing TypeScript files and migrate them to JSON equivalents");
    println("  --dry-run  Show what would be generated without writing files");
    println();
    println("Examples:");
    println("  od architect scaffold --module ../my-game --type classes");
    println("  od architect scaffold --module ../my-game --migrate   # migrate classes.ts + dm-config.ts");
    println("  od architect scaffold --type all --dry-run");
    return;
  }

  const args = parseArgs(argv);
  if (!args) {
    process.exit(1);
  }

  if (!existsSync(args.modulePath)) {
    printError(`Module directory not found: ${args.modulePath}`);
    process.exit(1);
  }

  printHeader("Architect Scaffold");
  println(color(`Module: ${args.modulePath}`, c.dim));
  println(color(`Target files: ${args.targetFiles.join(", ")}`, c.dim));
  if (args.migrate) println(color("Mode: migrate existing TypeScript files", c.dim));
  println();

  // Build scaffold input
  const scaffoldInput: ScaffoldInput = {
    modulePath: args.modulePath,
    targetFiles: args.targetFiles,
    settingJsonContent: readFileIfExists(join(args.modulePath, "setting.json")),
    existingClassesTs: args.migrate
      ? readFileIfExists(join(args.modulePath, "src/content/classes.ts"))
      : undefined,
    existingDmConfigTs: args.migrate
      ? readFileIfExists(join(args.modulePath, "src/content/dm-config.ts"))
      : undefined
  };

  // Optional developer instructions
  const instructions = await prompt(
    "Additional instructions for the Architect (or press Enter to skip): "
  );
  if (instructions) {
    scaffoldInput.developerInstructions = instructions;
  }

  println();
  println(color("Generating files...", c.dim));

  const scaffolder = new GameScaffolderRuntime();
  let result;
  try {
    result = await scaffolder.scaffold(scaffoldInput);
  } catch (err) {
    printError(`Scaffold failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (result.warnings.length > 0) {
    println(color("\nWarnings:", c.yellow));
    for (const w of result.warnings) {
      println(`  ${color("!", c.yellow)} ${w}`);
    }
  }

  if (result.files.length === 0) {
    println(color("No files generated.", c.dim));
    return;
  }

  println(color(`\nGenerated ${result.files.length} file(s):`, c.green));
  for (const file of result.files) {
    println(`  ${color(file.relativePath, c.bold)}`);
  }

  if (args.dryRun) {
    println(color("\nDry run — no files written.", c.dim));
    return;
  }

  println();
  for (const file of result.files) {
    const targetPath = join(args.modulePath, file.relativePath);
    const dirPath = targetPath.replace(/[/\\][^/\\]+$/, "");

    if (existsSync(targetPath)) {
      const overwrite = await prompt(
        `  ${color(file.relativePath, c.bold)} already exists. Overwrite? [y/N] `
      );
      if (overwrite.toLowerCase() !== "y") {
        println(`  ${color("Skipped", c.dim)} ${file.relativePath}`);
        continue;
      }
    }

    mkdirSync(dirPath, { recursive: true });
    writeFileSync(targetPath, file.content, "utf8");
    println(`  ${color("✓ Written", c.green)} ${file.relativePath}`);
  }

  println();
  println(color("Done! Review the generated files and adjust as needed.", c.green));
}
